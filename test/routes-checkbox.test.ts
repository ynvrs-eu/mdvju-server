// POST /file/checkbox. Every test runs against createApp() over a throwaway
// temp vault (makeVault).
//
// Tests named with a B- ID pin the API's behaviour; a still-open bug is
// `it.fails`.

import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import * as fs from "fs";
import * as path from "path";
import { NOTE_MAX_BYTES, NOTE_TOO_LARGE_MESSAGE } from "../shared/note-size";
import { api, makeApp, makeEscapeSymlink, makeVault, type TestVault } from "./support";

const TOKEN = "test-token-123";

/** Permission bits aren't enforced for root, so EACCES tests can't run as root. */
const IS_ROOT = process.getuid?.() === 0;

describe("POST /file/checkbox", () => {
  let v: TestVault;
  let app: ReturnType<typeof makeApp>;
  let http: ReturnType<typeof api>;
  let filePath: string;

  beforeAll(() => {
    v = makeVault();
    app = makeApp(v, { authToken: TOKEN });
    http = api(app, TOKEN);
  });

  afterAll(() => v.cleanup());

  beforeEach(() => {
    filePath = v.put(
      "Notes/Tasks.md",
      ["# Tasks", "", "- [ ] Plain task", "- [x] <!-- sp:abc-123 --> Synced task", "  - [ ] Subtask"].join("\n"),
    );
  });

  it("rejects a request with no Authorization header", async () => {
    const res = await request(app).post("/file/checkbox").send({ path: "Notes/Tasks.md", line: 3, checked: true, expectedLine: "- [ ] Plain task" });
    expect(res.status).toBe(401);
  });

  it("checks an unchecked box, preserving indentation and the rest of the line", async () => {
    const res = await http.post("/file/checkbox", { path: "Notes/Tasks.md", line: 3, checked: true, expectedLine: "- [ ] Plain task" });
    expect(res.status).toBe(200);
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content.split("\n")[2]).toBe("- [x] Plain task");
  });

  it("unchecks a checked box without touching a trailing sp: marker", async () => {
    const res = await http.post("/file/checkbox", {
      path: "Notes/Tasks.md",
      line: 4,
      checked: false,
      expectedLine: "- [x] <!-- sp:abc-123 --> Synced task",
    });
    expect(res.status).toBe(200);
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content.split("\n")[3]).toBe("- [ ] <!-- sp:abc-123 --> Synced task");
  });

  it("preserves indentation on a nested subtask", async () => {
    const res = await http.post("/file/checkbox", { path: "Notes/Tasks.md", line: 5, checked: true, expectedLine: "  - [ ] Subtask" });
    expect(res.status).toBe(200);
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content.split("\n")[4]).toBe("  - [x] Subtask");
  });

  it("returns 409 when the line is not a checkbox (file changed since the client fetched it)", async () => {
    const res = await http.post("/file/checkbox", { path: "Notes/Tasks.md", line: 1, checked: true, expectedLine: "# Tasks" });
    expect(res.status).toBe(409);
  });

  it("returns 409 for a line number past the end of the file", async () => {
    const res = await http.post("/file/checkbox", { path: "Notes/Tasks.md", line: 999, checked: true, expectedLine: "x" });
    expect(res.status).toBe(409);
  });

  it("returns 400 for a path-traversal attempt even with a valid token", async () => {
    const res = await http.post("/file/checkbox", { path: "../../../etc/passwd", line: 1, checked: true, expectedLine: "x" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a well-formed but nonexistent path", async () => {
    const res = await http.post("/file/checkbox", { path: "Notes/Nonexistent.md", line: 1, checked: true, expectedLine: "x" });
    expect(res.status).toBe(404);
  });

  it("returns 400 when checked is missing or the wrong type", async () => {
    const res = await http.post("/file/checkbox", { path: "Notes/Tasks.md", line: 3, expectedLine: "- [ ] Plain task" });
    expect(res.status).toBe(400);
  });

  // Required once every installed app sends it.
  it("returns 400 when expectedLine is missing, and the file is unchanged", async () => {
    const before = fs.readFileSync(filePath, "utf-8");
    const res = await http.post("/file/checkbox", { path: "Notes/Tasks.md", line: 3, checked: true });
    expect(res.status).toBe(400);
    expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
  });

  it("returns 400 when line is missing or the wrong type", async () => {
    const res = await http.post("/file/checkbox", { path: "Notes/Tasks.md", checked: true, expectedLine: "- [ ] Plain task" });
    expect(res.status).toBe(400);
  });

  // The app never opens a note over the cap, but
  // the API can be called directly, so the write refuses it too, before
  // reading it. Sparse file: a real task on line 1, then
  // zeros up to one byte over the cap.
  it("returns 413 for a note over NOTE_MAX_BYTES, and the file is unchanged", async () => {
    const big = v.put("Big/over.md", "- [ ] task\n");
    fs.truncateSync(big, NOTE_MAX_BYTES + 1);
    const mtimeBefore = fs.statSync(big).mtimeMs;
    const res = await http.post("/file/checkbox", { path: "Big/over.md", line: 1, checked: true, expectedLine: "- [ ] task" });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: NOTE_TOO_LARGE_MESSAGE });
    const st = fs.statSync(big);
    expect(st.size).toBe(NOTE_MAX_BYTES + 1);
    expect(st.mtimeMs).toBe(mtimeBefore);
    const head = Buffer.alloc(11);
    const fd = fs.openSync(big, "r");
    fs.readSync(fd, head, 0, 11, 0);
    fs.closeSync(fd);
    expect(head.toString("utf-8")).toBe("- [ ] task\n");
  });
});

describe("checkbox", () => {
  let v: TestVault;
  let http: ReturnType<typeof api>;

  beforeEach(() => {
    v = makeVault();
    http = api(makeApp(v, { authToken: TOKEN }), TOKEN);
  });

  afterEach(() => v.cleanup());

  // expectedLine is required. Like the app, send the target
  // line as it is in the file now, unless the test sets it itself.
  function postCheckbox(body: { path: string; line: number; checked: boolean; expectedLine?: string; baseEtag?: string }) {
    let expectedLine = body.expectedLine;
    if (expectedLine === undefined) {
      try {
        expectedLine = fs.readFileSync(path.join(v.root, body.path), "utf-8").split("\n")[body.line - 1] ?? "";
      } catch {
        expectedLine = "";
      }
    }
    return http.post("/file/checkbox", { ...body, expectedLine });
  }

  // The server only 409s when line N is no longer a checkbox at all.
  // The contract: an optional `expectedLine` field
  // carries the raw text of the line as the client loaded it (no line
  // terminator); when present and the current line differs, 409, no write.
  it("B-checkbox-01: a line inserted above the target makes the write 409, file unchanged", async () => {
    // The client loaded "- [ ] A\n- [ ] B\n" and wants to tick B (line 2)...
    v.put("Tasks.md", "- [ ] A\n- [ ] B\n");
    // ...but sync inserted a task above it before the tap landed.
    const changed = "- [ ] Inserted\n- [ ] A\n- [ ] B\n";
    v.put("Tasks.md", changed);

    const res = await postCheckbox({ path: "Tasks.md", line: 2, checked: true, expectedLine: "- [ ] B" });
    expect(res.status).toBe(409);
    expect(v.read("Tasks.md")).toBe(changed);
  });

  // The write follows symlinks out of the vault.
  it("B-checkbox-02: a write through an out-of-vault symlink is refused with 400, outside file unchanged", async () => {
    makeEscapeSymlink(v);
    const res = await postCheckbox({ path: "escape/tasks.md", line: 1, checked: true });
    expect(res.status).toBe(400);
    expect(v.read("tasks.md", v.outside)).toBe("- [ ] outside task\n");
  });

  // Dot-folders are writable by name.
  it("B-checkbox-03: a write to a dotfile path is refused with 400, file unchanged", async () => {
    v.put(".obsidian/tasks.md", "- [ ] hidden task\n");
    const res = await postCheckbox({ path: ".obsidian/tasks.md", line: 1, checked: true });
    expect(res.status).toBe(400);
    expect(v.read(".obsidian/tasks.md")).toBe("- [ ] hidden task\n");
  });

  // `.` doesn't match `\r`, so the regex never matches a CRLF line.
  it("B-checkbox-04: a CRLF checkbox line toggles and keeps its \\r", async () => {
    v.put("Crlf.md", "# Tasks\r\n- [ ] A\r\n- [ ] B\r\n");
    const res = await postCheckbox({ path: "Crlf.md", line: 2, checked: true });
    expect(res.status).toBe(200);
    expect(v.read("Crlf.md")).toBe("# Tasks\r\n- [x] A\r\n- [ ] B\r\n");
  });

  // writeFileSync has no try/catch, so a failed write goes to Express's
  // default HTML error handler instead of returning JSON.
  //
  // Both the folder (0555) and the file (0444) are locked: the file lock makes
  // today's in-place write fail (HTML 500, so this fails on the content-type),
  // the folder lock makes the fixed temp-file + rename write fail too (a
  // rename would happily replace a read-only file in a writable folder).
  // Skipped as root, where permission bits aren't enforced (act_runner images).
  it.skipIf(IS_ROOT)("B-checkbox-05: a write failure (EACCES) returns JSON 500, file unchanged, and the next request is still served", async () => {
    const full = v.put("Locked/Tasks.md", "- [ ] task\n");
    fs.chmodSync(full, 0o444);
    fs.chmodSync(path.dirname(full), 0o555);

    const res = await postCheckbox({ path: "Locked/Tasks.md", line: 1, checked: true });
    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(typeof res.body.error).toBe("string");
    expect(v.read("Locked/Tasks.md")).toBe("- [ ] task\n");

    const next = await http.get("/status");
    expect(next.status).toBe(200);
    expect(next.body).toEqual({ apiVersion: 1 });
  });

  it("B-checkbox-06: only the state character changes, byte for byte (sp marker, other lines, trailing newline)", async () => {
    const original =
      "---\ntags: [x]\n---\n# Tasks\n\n- [ ] first <!-- sp:1111-aaaa -->\n\t- [X] tabbed <!-- sp:2222-bbbb -->\n- [ ] last  \n";
    v.put("Bytes.md", original);
    const lines = original.split("\n");
    const lineOfFirst = lines.indexOf("- [ ] first <!-- sp:1111-aaaa -->") + 1;
    const lineOfTabbed = lines.indexOf("\t- [X] tabbed <!-- sp:2222-bbbb -->") + 1;

    const check = await postCheckbox({ path: "Bytes.md", line: lineOfFirst, checked: true });
    expect(check.status).toBe(200);
    const uncheck = await postCheckbox({ path: "Bytes.md", line: lineOfTabbed, checked: false });
    expect(uncheck.status).toBe(200);

    const expected = original
      .replace("- [ ] first <!-- sp:1111-aaaa -->", "- [x] first <!-- sp:1111-aaaa -->")
      .replace("\t- [X] tabbed <!-- sp:2222-bbbb -->", "\t- [ ] tabbed <!-- sp:2222-bbbb -->");
    const after = fs.readFileSync(path.join(v.root, "Bytes.md"));
    expect(after.equals(Buffer.from(expected, "utf-8"))).toBe(true);
    // Exactly two bytes differ from the original.
    const before = Buffer.from(original, "utf-8");
    expect(after.length).toBe(before.length);
    let diffs = 0;
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) diffs++;
    expect(diffs).toBe(2);
  });

  // The server used to accept a bare `- [ ]` that the app never renders as
  // a task. Both now use shared/tasks.ts: not a task.
  it("B-checkbox-07: a bare `- [ ]` with no space after it isn't a task: 409, file unchanged", async () => {
    v.put("Bare.md", "- [ ]\n- [ ] text\n");
    const res = await postCheckbox({ path: "Bare.md", line: 1, checked: true });
    expect(res.status).toBe(409);
    expect(v.read("Bare.md")).toBe("- [ ]\n- [ ] text\n");
  });

  // The contract: the response returns the
  // new mtime so the client can adopt it only if nothing else changed the file
  // in between. No `expectedLine` here: that is B-checkbox-01's bug.
  // One version token, the ETag. The write returns the ETag of the
  // content it wrote, the same value a following GET /file sends, so the app
  // can adopt it as its baseline version.
  it("B-checkbox-08: the write response includes the new content's etag, equal to GET /file's ETag", async () => {
    v.put("Tasks.md", "- [ ] A\n");
    const res = await postCheckbox({ path: "Tasks.md", line: 1, checked: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const file = await http.get("/file", { path: "Tasks.md" });
    expect(file.headers.etag).toBeTruthy();
    expect(res.body.etag).toBe(file.headers.etag);
  });

  // The write truncates and rewrites the file in place, so a reader
  // (sync client, Obsidian) can see it half-written. An atomic write builds a
  // temp file and renames it over the note: the note becomes a new inode, and
  // anyone still holding the old one (here a hard link, like an open reader)
  // keeps the complete old content. Deterministic, no timing involved.
  it("B-checkbox-09: the write replaces the file atomically (new inode, old content intact for a holder of the old file)", async () => {
    const full = v.put("Atomic.md", "# Tasks\n- [ ] A\n");
    const holder = path.join(v.outside, "old-atomic.md");
    fs.linkSync(full, holder);
    const inodeBefore = fs.statSync(full).ino;

    const res = await postCheckbox({ path: "Atomic.md", line: 2, checked: true });
    expect(res.status).toBe(200);
    expect(v.read("Atomic.md")).toBe("# Tasks\n- [x] A\n");
    expect(fs.readFileSync(holder, "utf-8")).toBe("# Tasks\n- [ ] A\n");
    expect(fs.statSync(full).ino).not.toBe(inodeBefore);
  });

  it("B-checkbox-10: a matching `expectedLine` writes normally", async () => {
    v.put("Tasks.md", "- [ ] A\n- [ ] B\n");
    const res = await postCheckbox({ path: "Tasks.md", line: 2, checked: true, expectedLine: "- [ ] B" });
    expect(res.status).toBe(200);
    expect(v.read("Tasks.md")).toBe("- [ ] A\n- [x] B\n");
  });

  // The server applies the app's fence rule too (``` and ~~~,
  // closing on as many of the same character), for an old app or a
  // hand-made request.
  it("B-checkbox-13: a task inside a ``` or ~~~ fence is refused with 409, file unchanged; a task after the fence still toggles", async () => {
    const note = "```\n- [ ] in backticks\n```\n~~~~\n~~~\n- [ ] in tildes\n~~~~\n- [ ] real\n";
    v.put("Fenced.md", note);
    for (const line of [2, 6]) {
      const res = await postCheckbox({ path: "Fenced.md", line, checked: true });
      expect(res.status, `line ${line}`).toBe(409);
    }
    expect(v.read("Fenced.md")).toBe(note);
    const ok = await postCheckbox({ path: "Fenced.md", line: 8, checked: true });
    expect(ok.status).toBe(200);
    expect(v.read("Fenced.md")).toBe(note.replace("- [ ] real", "- [x] real"));
  });

  // The atomic write replaces the file, so it must carry the old permission
  // bits over: group-writable notes are 0664, and a fresh file
  // would get the umask's 0644.
  // A rename only needs folder write access, so the atomic write
  // must check the note itself is writable, or it replaces a read-only note
  // (and takes over its ownership) where the old in-place write got EACCES.
  // Unlike B-checkbox-05 the folder stays writable here.
  it.skipIf(IS_ROOT)("B-checkbox-12: a read-only note in a writable folder is refused with JSON 500, file and inode unchanged", async () => {
    const full = v.put("ReadOnly.md", "- [ ] task\n");
    fs.chmodSync(full, 0o444);
    const inodeBefore = fs.statSync(full).ino;

    const res = await postCheckbox({ path: "ReadOnly.md", line: 1, checked: true });
    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(v.read("ReadOnly.md")).toBe("- [ ] task\n");
    expect(fs.statSync(full).ino).toBe(inodeBefore);
    expect(fs.readdirSync(path.dirname(full)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("B-checkbox-11: the atomic write keeps the note's permission bits", async () => {
    const full = v.put("Mode.md", "- [ ] A\n");
    fs.chmodSync(full, 0o664);
    const res = await postCheckbox({ path: "Mode.md", line: 1, checked: true });
    expect(res.status).toBe(200);
    expect(fs.statSync(full).mode & 0o777).toBe(0o664);
  });

  // The .md rule was only on GET /file; the write took any file with a
  // checkbox line.
  it("B-checkbox-18: a write to a non-.md file is refused with 400, file unchanged", async () => {
    v.put("todo.txt", "- [ ] A\n");
    const res = await postCheckbox({ path: "todo.txt", line: 1, checked: true });
    expect(res.status).toBe(400);
    expect(v.read("todo.txt")).toBe("- [ ] A\n");
  });

  // The write's ETag also covers any external edit made since
  // the client's version, so the client may adopt it only if the write
  // went onto the version it has.
  it("B-checkbox-19: `baseMatched` says whether the write went onto the client's version (F1)", async () => {
    v.put("Base.md", "- [ ] A\n- [ ] B\n");
    const loaded = await http.get("/file", { path: "Base.md" });
    const baseEtag = loaded.headers["etag"];

    const same = await postCheckbox({ path: "Base.md", line: 1, checked: true, baseEtag });
    expect(same.status).toBe(200);
    expect(same.body.baseMatched).toBe(true);

    v.put("Base.md", "- [x] A\n- [ ] B\n- [ ] added elsewhere\n");
    const stale = await postCheckbox({ path: "Base.md", line: 2, checked: true, baseEtag: same.body.etag });
    expect(stale.status).toBe(200);
    expect(stale.body.baseMatched).toBe(false);

    const none = await postCheckbox({ path: "Base.md", line: 2, checked: false });
    expect(none.body.baseMatched).toBe(false);
  });

  // The temp file took this process's primary group, so the
  // rename changed the note's group. The note needs a group other than the
  // one a fresh file in its folder gets (the primary group, or the folder's
  // on a setgid folder), and one this process may chown to. Which groups
  // qualify depends on the filesystem: on an NFS export the server
  // only honours groups it knows the user is in.
  it("B-checkbox-16: the atomic write keeps the note's group", async (ctx) => {
    const full = v.put("Group.md", "- [ ] A\n");
    const freshGid = fs.statSync(full).gid;
    const other = (process.getgroups?.() ?? []).find((g) => {
      if (g === freshGid) return false;
      try {
        fs.chownSync(full, -1, g);
        return true;
      } catch {
        return false;
      }
    });
    if (other === undefined) ctx.skip();
    const res = await postCheckbox({ path: "Group.md", line: 1, checked: true });
    expect(res.status).toBe(200);
    expect(v.read("Group.md")).toBe("- [x] A\n");
    expect(fs.statSync(full).gid).toBe(other);
  });

  // The rename targeted the link path, so the link became a
  // plain file holding the tick, and the real note kept `[ ]`.
  it("B-checkbox-14: a tick through an in-vault symlink ticks the real note and leaves the link a link", async () => {
    v.put("Real.md", "- [ ] task\n");
    const link = path.join(v.root, "Link.md");
    fs.symlinkSync(path.join(v.root, "Real.md"), link);
    const res = await postCheckbox({ path: "Link.md", line: 1, checked: true });
    expect(res.status).toBe(200);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(v.read("Real.md")).toBe("- [x] task\n");
  });

  it("B-checkbox-15: a write through an in-vault symlink into a dot-folder is refused with 400, target unchanged", async () => {
    v.put(".obsidian/tasks.md", "- [ ] hidden\n");
    fs.symlinkSync(path.join(v.root, ".obsidian", "tasks.md"), path.join(v.root, "Peek.md"));
    const res = await postCheckbox({ path: "Peek.md", line: 1, checked: true, expectedLine: "- [ ] hidden" });
    expect(res.status).toBe(400);
    expect(v.read(".obsidian/tasks.md")).toBe("- [ ] hidden\n");
  });
});
