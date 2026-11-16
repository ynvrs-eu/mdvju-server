import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { resolveVaultPath } from "./vault-path";
import { sweepStaleTempFiles } from "./atomic-write";
import { createVaultIndex } from "./vault-index";
import { hasDisplayableContent } from "../shared/frontmatter";
import { makeVault, type TestVault } from "./test-support";

describe("resolveVaultPath", () => {
  let vault: TestVault;
  let vaultRoot: string;

  beforeAll(() => {
    vault = makeVault({ "Notes/Hello.md": "hello world", ".git/config": "fake git internals" });
    vaultRoot = vault.root;

    // a real file just outside the vault, to prove traversal is actually blocked
    fs.writeFileSync(path.join(vaultRoot, "..", "outside-secret.txt"), "top secret", "utf-8");
  });

  afterAll(() => {
    vault.cleanup(); // the outside file sits in the same temp dir
  });

  it("resolves a normal relative path inside the vault", () => {
    const resolved = resolveVaultPath(vaultRoot, "Notes/Hello.md");
    expect(resolved).toBe(path.join(path.resolve(vaultRoot), "Notes", "Hello.md"));
  });

  it("rejects a ../ path-traversal attempt", () => {
    expect(resolveVaultPath(vaultRoot, "../outside-secret.txt")).toBeNull();
  });

  it("rejects a deeper ../.. traversal attempt", () => {
    expect(resolveVaultPath(vaultRoot, "Notes/../../outside-secret.txt")).toBeNull();
  });

  it("treats a leading-slash path as vault-relative rather than reading the real /etc/passwd", () => {
    // A query param of "/etc/passwd" must NOT resolve to the host's real
    // /etc/passwd -- it's reinterpreted as relative to the vault root,
    // landing (safely, and non-existently) at <vaultRoot>/etc/passwd.
    const resolved = resolveVaultPath(vaultRoot, "/etc/passwd");
    expect(resolved).not.toBeNull();
    expect(resolved).toBe(path.join(path.resolve(vaultRoot), "etc", "passwd"));
    expect(resolved).not.toBe("/etc/passwd");
  });

  it("indexes markdown files and skips dotfiles/dot-directories", async () => {
    const files = (await createVaultIndex(vaultRoot).get()).notes.map((n) => n.path);
    expect(files).toContain("Notes/Hello.md");
    expect(files.some((f) => f.includes(".git"))).toBe(false);
  });
});

describe("hasDisplayableContent", () => {
  it("is false for a completely empty file", () => {
    expect(hasDisplayableContent("")).toBe(false);
  });

  it("is false for whitespace only", () => {
    expect(hasDisplayableContent("\n  \n")).toBe(false);
  });

  it("is false for frontmatter with nothing after it", () => {
    expect(hasDisplayableContent("---\nstatus: active\ntags: [a, b]\n---\n")).toBe(false);
  });

  it("is false for frontmatter followed only by whitespace", () => {
    expect(hasDisplayableContent("---\nstatus: active\n---\n\n  \n")).toBe(false);
  });

  it("is true for plain body text with no frontmatter", () => {
    expect(hasDisplayableContent("hello world")).toBe(true);
  });

  it("is true for frontmatter followed by real content", () => {
    expect(hasDisplayableContent("---\nstatus: active\n---\n# Heading\n")).toBe(true);
  });
});

describe("sweepStaleTempFiles", () => {
  it("removes old atomic-write temp files anywhere in the vault, and nothing else", () => {
    const tmp = makeVault();
    const vault = tmp.root;
    const put = (rel: string, ageMs: number) => {
      const full = tmp.put(rel, "x");
      const t = (Date.now() - ageMs) / 1000;
      fs.utimesSync(full, t, t);
      return full;
    };
    const stale = put("Notes/.Tasks.md.123.1759740000000.tmp", 10 * 60_000);
    const staleState = put(".mdvju/.state.json.9.1759740000000.tmp", 10 * 60_000);
    const fresh = put("Notes/.Tasks.md.456.1759749999999.tmp", 1_000); // a write in flight
    const note = put("Notes/Tasks.md", 10 * 60_000);
    const otherTmp = put("Notes/report.tmp", 10 * 60_000); // not our pattern
    const inGit = put(".git/.x.md.1.2.tmp", 10 * 60_000);

    const removed = sweepStaleTempFiles(vault);

    expect(removed.sort()).toEqual([stale, staleState].sort());
    for (const kept of [fresh, note, otherTmp, inGit]) expect(fs.existsSync(kept)).toBe(true);
    tmp.cleanup();
  });
});
