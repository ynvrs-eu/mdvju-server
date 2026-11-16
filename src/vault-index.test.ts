import { afterEach, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { NOTE_MAX_BYTES } from "../shared/note-size";
import { createVaultIndex } from "./vault-index";
import { makeVault, type TestVault } from "./test-support";

let vault: TestVault | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  vault?.cleanup();
  vault = null;
});

// Every file operation in a walk catches its
// own errors, so only a programming error can make a task reject. When one
// does, the build rejects and the pump starts no further tasks.
it("a task that throws rejects the build and no further tasks start", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 100; i++) files[`Note ${i}.md`] = "body\n";
  vault = makeVault(files);
  const root = vault.root;

  // The root listing starts with an entry whose visit throws.
  const bad = {
    name: "bad.md",
    isDirectory() {
      throw new Error("boom");
    },
    isFile: () => true,
    isSymbolicLink: () => false,
  } as unknown as fs.Dirent;
  const realReaddir = fs.promises.readdir.bind(fs.promises) as (dir: string, opts: { withFileTypes: true }) => Promise<fs.Dirent[]>;
  vi.spyOn(fs.promises, "readdir").mockImplementation((async (dir: string, opts: { withFileTypes: true }) => {
    const entries = await realReaddir(dir, opts);
    return dir === root ? [bad, ...entries] : entries;
  }) as unknown as typeof fs.promises.readdir);
  // Each visited note does one stat; count them.
  const stat = vi.spyOn(fs.promises, "stat");

  await expect(createVaultIndex(root, 0).get()).rejects.toThrow("boom");
  // Let the tasks already in flight finish; none of them may start another.
  await new Promise((r) => setTimeout(r, 200));
  // The throwing task and the 31 started alongside it (32 workers), not all 100.
  expect(stat.mock.calls.length).toBeLessThanOrEqual(31);
  expect(stat.mock.calls.length).toBeGreaterThan(0);
});

// get() answers from the last snapshot however old it
// is, so a lookup that misses asks fresh(): the same snapshot while it's
// within the TTL, else the rebuild's, shared with one already running.
it("fresh() waits for a rebuild past the TTL, and reuses a snapshot within it", async () => {
  vault = makeVault({ "a.png": "x" });
  const index = createVaultIndex(vault.root, 50);
  const first = await index.get();
  expect(await index.fresh()).toBe(first); // within the TTL: no walk
  await new Promise((r) => setTimeout(r, 120));
  vault.put("New Folder/b.png", "y");
  expect((await index.get()).files).toEqual(["a.png"]); // stale, at once
  const [one, two] = await Promise.all([index.fresh(), index.fresh()]);
  expect(one).toBe(two); // one rebuild, shared
  expect(one.files).toEqual(["New Folder/b.png", "a.png"]);
  expect(one.folders).toEqual(["New Folder"]);
});

// The index reads every note anyway, so it also says which have
// something to show, and /recent reads no note itself. Like the aliases,
// that's read again only when the note's mtime changes.
it("knows which notes are displayable, read again only on a new mtime", async () => {
  vault = makeVault({
    "Body.md": "# Title\n",
    "Empty.md": "",
    "Frontmatter.md": "---\ntags: [a]\n---\n<!-- only a comment -->\n",
  });
  const old = new Date("2026-10-01T12:00:00Z");
  fs.utimesSync(`${vault.root}/Empty.md`, old, old);
  const index = createVaultIndex(vault.root, 0);
  expect([...(await index.get()).displayable]).toEqual(["Body.md"]);

  vault.put("Empty.md", "now with text\n");
  fs.utimesSync(`${vault.root}/Empty.md`, old, old);
  expect((await index.get()).displayable.has("Empty.md")).toBe(false);

  const later = new Date(old.getTime() + 5000);
  fs.utimesSync(`${vault.root}/Empty.md`, later, later);
  expect((await index.get()).displayable.has("Empty.md")).toBe(true);
});

// A read that fails once (EACCES, a transient EIO on the NFS
// share prod runs on) isn't cached as "nothing to show": the note comes back
// to /recent on the next build, with its mtime unchanged.
it("a failed read isn't cached: the note is displayable once it reads again, same mtime", async () => {
  vault = makeVault({ "Body.md": "# Title\n" });
  const full = `${vault.root}/Body.md`;
  const realReadFile = fs.promises.readFile;
  const spy = vi.spyOn(fs.promises, "readFile").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) =>
    String(p) === full
      ? Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }))
      : (realReadFile as (...a: unknown[]) => Promise<unknown>)(p, ...rest)) as typeof fs.promises.readFile);
  const index = createVaultIndex(vault.root, 0);
  const mtime = fs.statSync(full).mtimeMs;
  expect((await index.get()).displayable.has("Body.md")).toBe(false);

  spy.mockRestore();
  expect(fs.statSync(full).mtimeMs).toBe(mtime);
  expect((await index.get()).displayable.has("Body.md")).toBe(true);
});

// A note over the cap is never read into memory.
// It's still listed, so search and the tree find it and
// opening it says it's too large, with no aliases and counted as
// displayable, like a note the folder source hasn't read. One at the cap is
// read as usual. Sparse files: frontmatter, then zeros up to the size.
it("lists a note over NOTE_MAX_BYTES without reading it; one at the cap is read", async () => {
  vault = makeVault({ "Over.md": "---\naliases: [Big]\n---\n", "At.md": "---\naliases: [AtCap]\n---\n" });
  fs.truncateSync(path.join(vault.root, "Over.md"), NOTE_MAX_BYTES + 1);
  fs.truncateSync(path.join(vault.root, "At.md"), NOTE_MAX_BYTES);
  const readFile = vi.spyOn(fs.promises, "readFile");

  const snap = await createVaultIndex(vault.root, 0).get();
  const read = readFile.mock.calls.map((c) => path.basename(String(c[0])));
  expect(read).not.toContain("Over.md");
  expect(read).toContain("At.md");
  expect(snap.notes.find((n) => n.path === "Over.md")?.aliases).toEqual([]);
  expect(snap.notes.find((n) => n.path === "At.md")?.aliases).toEqual(["AtCap"]);
  expect(snap.displayable.has("Over.md")).toBe(true);
});
