// GET /search, GET /recent, GET /tree and GET /paths, and how they list
// in-vault symlinks. Every test runs against createApp() over a throwaway temp vault
// (makeVault). What they answer for an ordinary vault (B-search-*,
// B-recent-*, B-tree-*, B-paths-01) is in the shared source vectors,
// test/vectors/source/ (source-vectors.test.ts), run against both sources;
// only the HTTP-only and backend-only cases are here.
//
// Tests named with a B- ID pin the API's behaviour; a still-open bug is
// `it.fails`.

import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import * as fs from "fs";
import * as path from "path";
import { api, makeApp, makeEscapeSymlink, makeVault, type TestVault } from "./support";

const TOKEN = "test-token-123";

// One vault and app for the HTTP-only groups below.
let shared: TestVault;
let app: ReturnType<typeof makeApp>;

beforeAll(() => {
  shared = makeVault({ "Notes/Hello World.md": "hi" });
  app = makeApp(shared, { authToken: TOKEN });
});

afterAll(() => shared.cleanup());

describe("GET /tree", () => {
  it("rejects a request with no Authorization header", async () => {
    expect((await request(app).get("/tree")).status).toBe(401);
  });
});

describe("GET /search", () => {
  it("rejects a request with no Authorization header", async () => {
    const res = await request(app).get("/search").query({ q: "hello" });
    expect(res.status).toBe(401);
  });

  it("returns an empty array when the query param is missing", async () => {
    const res = await api(app, TOKEN).get("/search");
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });
});

describe("GET /recent", () => {
  it("rejects a request with no Authorization header", async () => {
    const res = await request(app).get("/recent");
    expect(res.status).toBe(401);
  });
});

// The groups below get a fresh vault and app per test.
let v: TestVault;
let http: ReturnType<typeof api>;

function freshVaultPerTest() {
  beforeEach(() => {
    v = makeVault();
    http = api(makeApp(v, { authToken: TOKEN }), TOKEN);
  });
  afterEach(() => v.cleanup());
}

// GET /file followed in-vault symlinks, but search, recent,
// resolve and tree never listed them. One policy now: follow in-vault
// links, leave out ones leading out of the vault or into a dot-folder.
describe("in-vault symlinks", () => {
  freshVaultPerTest();

  function makeLinks() {
    v.put("Real/Target Note.md", "# Target\n");
    v.put(".obsidian/hidden.md", "# hidden\n");
    fs.symlinkSync(path.join(v.root, "Real"), path.join(v.root, "Linked"), "dir");
    fs.symlinkSync(path.join(v.root, "Real", "Target Note.md"), path.join(v.root, "Alias Note.md"));
    fs.symlinkSync(path.join(v.root, ".obsidian", "hidden.md"), path.join(v.root, "Peek.md"));
    fs.symlinkSync(v.root, path.join(v.root, "Real", "loop"), "dir");
    makeEscapeSymlink(v);
  }

  it("B-link-01: search lists notes through in-vault links, but not through links out or into dot-folders", async () => {
    makeLinks();
    const res = await http.get("/search", { q: "note" });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual(expect.arrayContaining(["Alias Note.md", "Linked/Target Note.md", "Real/Target Note.md"]));
    expect(res.body.results.some((p: string) => p.startsWith("escape/") || p === "Peek.md")).toBe(false);
  });

  it("B-link-02: a link back to an ancestor folder doesn't loop", async () => {
    makeLinks();
    const res = await http.get("/search", { q: "target" });
    expect(res.status).toBe(200);
    expect(res.body.results.filter((p: string) => p.includes("loop/"))).toEqual([]);
  });

  it("B-link-03: a wikilink resolves to a note reached only through an in-vault link", async () => {
    v.put("Real/Only Here.md", "# x\n");
    fs.symlinkSync(path.join(v.root, "Real", "Only Here.md"), path.join(v.root, "Linked Here.md"));
    const res = await http.get("/resolve", { link: "Linked Here" });
    expect(res.body.path).toBe("Linked Here.md");
  });

  it("B-link-04: /tree lists an in-vault linked folder and note, not a link out or into a dot-folder", async () => {
    makeLinks();
    const res = await http.get("/tree");
    expect(res.status).toBe(200);
    expect(res.body.folders).toEqual(expect.arrayContaining(["Linked", "Real"]));
    expect(res.body.folders).not.toContain("escape");
    expect(res.body.files).toContain("Alias Note.md");
    expect(res.body.files).not.toContain("Peek.md");
  });

  // /tree listed the link, so
  // the folder browser could go down Real/loop/Real/loop/... without end.
  it("B-link-05: /tree, like /paths, leaves out a link back to an ancestor folder and finds nothing through it", async () => {
    makeLinks();
    fs.symlinkSync(path.join(v.root, "Real"), path.join(v.root, "Real", "self"), "dir");
    const real = await http.get("/tree", { path: "Real" });
    expect(real.status).toBe(200);
    expect(real.body.folders).toEqual([]);
    expect(real.body.files).toEqual(["Real/Target Note.md"]);
    // Through the in-vault link Linked -> Real, the same.
    expect((await http.get("/tree", { path: "Linked" })).body.folders).toEqual([]);
    for (const p of ["Real/loop", "Real/loop/Real", "Real/self", "Linked/self"]) {
      expect((await http.get("/tree", { path: p })).status, p).toBe(404);
    }
  });
});

describe("paths", () => {
  freshVaultPerTest();

  it("rejects a request with no Authorization header", async () => {
    const res = await request(makeApp(v, { authToken: TOKEN })).get("/paths");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
  });

  it("B-paths-02: follows in-vault links, not links out, into a dot-folder or back to an ancestor", async () => {
    v.put("Real/Target Note.md", "# Target\n");
    v.put(".obsidian/hidden.md", "# hidden\n");
    fs.symlinkSync(path.join(v.root, "Real"), path.join(v.root, "Linked"), "dir");
    fs.symlinkSync(path.join(v.root, "Real", "Target Note.md"), path.join(v.root, "Alias Note.md"));
    fs.symlinkSync(path.join(v.root, ".obsidian", "hidden.md"), path.join(v.root, "Peek.md"));
    fs.symlinkSync(path.join(v.root, ".obsidian"), path.join(v.root, "Settings"), "dir");
    fs.symlinkSync(v.root, path.join(v.root, "Real", "loop"), "dir");
    makeEscapeSymlink(v);
    const res = await http.get("/paths");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      folders: ["Linked", "Real"],
      files: ["Alias Note.md", "Linked/Target Note.md", "Real/Target Note.md"],
    });
  });
});
