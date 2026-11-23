// GET /file. Every test runs against createApp() over a throwaway temp
// vault (makeVault).
//
// Tests named with a B- ID pin the API's behaviour; a still-open bug is
// `it.fails`.

import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createHmac } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { NOTE_MAX_BYTES, NOTE_TOO_LARGE_MESSAGE } from "../shared/note-size";
import { api, makeApp, makeEscapeSymlink, makeVault, type TestVault } from "./support";

const TOKEN = "test-token-123";

describe("GET /file", () => {
  let v: TestVault;
  let app: ReturnType<typeof makeApp>;
  let http: ReturnType<typeof api>;

  beforeAll(() => {
    v = makeVault({ "Notes/Hello.md": "# Hello\n\nworld", "Notes/Other Note.md": "# Other\n\nsee [[Hello]]" });
    app = makeApp(v, { authToken: TOKEN });
    http = api(app, TOKEN);
  });

  afterAll(() => v.cleanup());

  it("rejects a request with no Authorization header", async () => {
    const res = await request(app).get("/file").query({ path: "Notes/Hello.md" });
    expect(res.status).toBe(401);
  });

  it("rejects a request with the wrong token", async () => {
    const res = await request(app)
      .get("/file")
      .query({ path: "Notes/Hello.md" })
      .set("Authorization", "Bearer wrong-token");
    expect(res.status).toBe(401);
  });

  it("returns raw file content for a valid token and path", async () => {
    const res = await http.get("/file", { path: "Notes/Hello.md" });
    expect(res.status).toBe(200);
    expect(res.text).toBe("# Hello\n\nworld");
  });

  it("returns 400 for a path-traversal attempt even with a valid token", async () => {
    const res = await http.get("/file", { path: "../../../etc/passwd" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a well-formed but nonexistent path", async () => {
    const res = await http.get("/file", { path: "Notes/Nonexistent.md" });
    expect(res.status).toBe(404);
  });

  it("returns 400 when path query param is missing", async () => {
    const res = await http.get("/file");
    expect(res.status).toBe(400);
  });
});

describe("file", () => {
  let v: TestVault;
  let http: ReturnType<typeof api>;

  beforeEach(() => {
    v = makeVault();
    http = api(makeApp(v, { authToken: TOKEN }), TOKEN);
  });

  afterEach(() => v.cleanup());

  // Dotfiles (plugin API keys, .git/config) are readable by name.
  it("B-file-01: GET /file refuses a dotfile path like .obsidian/data.json with 400", async () => {
    v.put(".obsidian/data.json", '{"apiKey":"s3cret"}');
    const res = await http.get("/file", { path: ".obsidian/data.json" });
    expect(res.status).toBe(400);
    expect(res.text).not.toContain("s3cret");
  });

  // Containment checks the path text, not where it leads.
  it("B-file-02: GET /file refuses a path through a symlink leading out of the vault with 400", async () => {
    makeEscapeSymlink(v);
    const res = await http.get("/file", { path: "escape/secret.md" });
    expect(res.status).toBe(400);
    expect(res.text).not.toContain("Outside the vault");
  });

  // /file reads any extension, not just notes.
  it("B-file-03: GET /file refuses a non-.md path with 400", async () => {
    v.put("Notes/config.json", '{"k":"v"}');
    const res = await http.get("/file", { path: "Notes/config.json" });
    expect(res.status).toBe(400);
  });

  // /file and /file/meta are separate requests, so a change landing
  // between them is lost. The contract: /file carries an
  // ETag for the content it returned and honours If-None-Match, so a client
  // can poll /file conditionally and never pair content with a later mtime.
  // The ETag's format is not pinned (no mtimeMs equality). Express's default
  // content-hash ETag meets this today, so the remaining gap is client-side,
  // and this test guards the contract the client fix relies on.
  it("B-file-04: GET /file sends an ETag that changes with the content and honours If-None-Match with 304", async () => {
    v.put("Note.md", "# Note\n");
    const get = (etag?: string) => {
      const r = http.get("/file", { path: "Note.md" });
      return etag === undefined ? r : r.set("If-None-Match", etag);
    };

    const first = await get();
    expect(first.status).toBe(200);
    const etag = String(first.headers["etag"] ?? "");
    expect(etag).toMatch(/^(W\/)?"[^"]+"$/); // RFC 9110 entity-tag
    expect((await get()).headers["etag"]).toBe(etag); // stable while unchanged

    const notModified = await get(etag);
    expect(notModified.status).toBe(304);
    expect(notModified.text ?? "").toBe("");

    v.put("Note.md", "# Note\n\nchanged\n");
    const changed = await get(etag);
    expect(changed.status).toBe(200);
    expect(changed.text).toBe("# Note\n\nchanged\n");
    expect(changed.headers["etag"]).toMatch(/^(W\/)?"[^"]+"$/);
    expect(changed.headers["etag"]).not.toBe(etag);
  });

  // The symlink fix must not over-block: a symlink that stays inside the vault
  // still reads, and so does a vault whose root path is itself a symlink.
  it("B-file-06: a symlink within the vault, and a vault root reached through a symlink, still read", async () => {
    v.put("Real/Note.md", "# Inside\n");
    fs.symlinkSync(path.join(v.root, "Real"), path.join(v.root, "Linked"), "dir");
    const viaLink = await http.get("/file", { path: "Linked/Note.md" });
    expect(viaLink.status).toBe(200);
    expect(viaLink.text).toBe("# Inside\n");

    const rootLink = path.join(v.outside, "vault-link");
    fs.symlinkSync(v.root, rootLink, "dir");
    const app = makeApp(v, { vaultRoot: rootLink, authToken: TOKEN });
    const viaRoot = await api(app, TOKEN).get("/file", { path: "Real/Note.md" });
    expect(viaRoot.status).toBe(200);
  });

  // A 0-byte note (an agent's emptied inbox.md, seen live 2026-10-07) is a
  // normal note: 200 with an empty body and an ETag, so the app shows "no
  // displayable content" and its change poll still works on it. /recent
  // leaves it out (nothing to show).
  it("B-file-07: a 0-byte note reads as 200, empty body, with an ETag; /recent leaves it out", async () => {
    v.put("Inbox/inbox.md", "");
    const res = await http.get("/file", { path: "Inbox/inbox.md" });
    expect(res.status).toBe(200);
    expect(res.text).toBe("");
    const etag = String(res.headers["etag"] ?? "");
    expect(etag).toMatch(/^(W\/)?"[^"]+"$/);
    const again = await http.get("/file", { path: "Inbox/inbox.md" }).set("If-None-Match", etag);
    expect(again.status).toBe(304);
    const recent = await http.get("/recent");
    expect(recent.body.results.map((r: { path: string }) => r.path)).not.toContain("Inbox/inbox.md");
  });

  // Found while fixing the symlink rule: the dot rule was only checked on the
  // requested path, so an in-vault link into a dot-folder read through.
  it("B-file-08: a symlink inside the vault pointing into a dot-folder is refused with 400", async () => {
    v.put(".obsidian/secret.md", "# hidden\n");
    fs.symlinkSync(path.join(v.root, ".obsidian", "secret.md"), path.join(v.root, "Peek.md"));
    const res = await http.get("/file", { path: "Peek.md" });
    expect(res.status).toBe(400);
  });

  // 2026-11-03: a note too big for the phone's memory is refused before it's
  // read. The file is sparse: its size is all that counts.
  it("B-file-09: a note over NOTE_MAX_BYTES is 413 with the size message; one at the cap still reads", async () => {
    v.put("Big/over.md", "");
    fs.truncateSync(path.join(v.root, "Big/over.md"), NOTE_MAX_BYTES + 1);
    const res = await http.get("/file", { path: "Big/over.md" });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: NOTE_TOO_LARGE_MESSAGE });
    v.put("Big/at.md", "");
    fs.truncateSync(path.join(v.root, "Big/at.md"), NOTE_MAX_BYTES);
    const at = await http.get("/file", { path: "Big/at.md" });
    expect(at.status).toBe(200);
    expect(at.text.length).toBe(NOTE_MAX_BYTES);
    v.put("Big/under.md", "");
    fs.truncateSync(path.join(v.root, "Big/under.md"), NOTE_MAX_BYTES - 1);
    const under = await http.get("/file", { path: "Big/under.md" });
    expect(under.status).toBe(200);
    expect(under.text.length).toBe(NOTE_MAX_BYTES - 1);
  });

  it("B-file-09a: the cap is 5 MB (5 × 1024 × 1024 bytes) and the message is the one the app shows", () => {
    expect(NOTE_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(NOTE_TOO_LARGE_MESSAGE).toBe("This note is too large to show.");
  });
});

// GET /file/download: a note's raw bytes at any size, for "Open in another
// app" on a note /file refuses.
describe("GET /file/download", () => {
  let v: TestVault;
  let app: ReturnType<typeof makeApp>;
  let http: ReturnType<typeof api>;

  beforeAll(() => {
    v = makeVault({ "Notes/Hello.md": "# Hello\n\nżółw", "Notes/pic.png": "png" });
    app = makeApp(v, { authToken: TOKEN });
    http = api(app, TOKEN);
  });

  afterAll(() => v.cleanup());

  it("B-file-10: a note over the cap downloads whole, as Markdown, with its length; /file still refuses it", async () => {
    v.put("Big/over.md", "");
    fs.truncateSync(path.join(v.root, "Big/over.md"), NOTE_MAX_BYTES + 1);
    expect((await http.get("/file", { path: "Big/over.md" })).status).toBe(413);
    const res = await http.get("/file/download", { path: "Big/over.md" }).buffer(true).parse((r, done) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => done(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(res.headers["content-length"]).toBe(String(NOTE_MAX_BYTES + 1));
    expect(res.headers["cache-control"]).toBe("no-store");
    expect((res.body as Buffer).length).toBe(NOTE_MAX_BYTES + 1);
  });

  it("B-file-11: a small note downloads byte for byte", async () => {
    const res = await http.get("/file/download", { path: "Notes/Hello.md" }).buffer(true).parse((r, done) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => done(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).equals(fs.readFileSync(path.join(v.root, "Notes/Hello.md")))).toBe(true);
  });

  it("B-file-12: only .md notes inside the vault; missing is 404, no path 400", async () => {
    expect((await http.get("/file/download", { path: "Notes/pic.png" })).status).toBe(400);
    expect((await http.get("/file/download", { path: "../outside.md" })).status).toBe(400);
    expect((await http.get("/file/download", { path: ".obsidian/x.md" })).status).toBe(400);
    expect((await http.get("/file/download", { path: "Notes/Nope.md" })).status).toBe(404);
    expect((await http.get("/file/download")).status).toBe(400);
  });

  it("B-file-13: needs the Bearer header; the attachment key doesn't open it", async () => {
    expect((await request(app).get("/file/download").query({ path: "Notes/Hello.md" })).status).toBe(401);
    const key = createHmac("sha256", TOKEN).update("attachment-v1").digest("hex");
    expect((await request(app).get("/file/download").query({ path: "Notes/Hello.md", key })).status).toBe(401);
  });
});
