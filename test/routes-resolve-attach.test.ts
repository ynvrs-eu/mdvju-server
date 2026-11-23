// GET /resolve, GET /resolve-embed and GET /attachment. Every test runs
// against createApp() over a throwaway temp vault (makeVault). Aborted
// /attachment streams are in attachment-abort.test.ts (a real socket).
// What /resolve and /resolve-embed answer (B-resolve-*) is in the shared
// source vectors, test/vectors/source/resolve/ (source-vectors.test.ts);
// only the HTTP-only cases are here.
//
// Tests named with a B- ID pin the API's behaviour; a still-open bug is
// `it.fails`: when the fix lands,
// vitest reports it as failing -- flip it to `it`).

import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import * as fs from "fs";
import * as path from "path";
import { createAttachmentInfo, SIZE_MEMO_ENTRIES } from "../src/attachment-info";
import { openVault } from "../src/vault";
import { api, makeApp, makeEscapeSymlink, makeVault, type TestVault } from "./support";

const TOKEN = "test-token-123";
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("GET /resolve", () => {
  let v: TestVault;
  let app: ReturnType<typeof makeApp>;
  let http: ReturnType<typeof api>;

  beforeAll(() => {
    v = makeVault({ "Notes/Hello.md": "# Hello\n\nworld" });
    app = makeApp(v, { authToken: TOKEN });
    http = api(app, TOKEN);
  });

  afterAll(() => v.cleanup());

  it("rejects a request with no Authorization header", async () => {
    const res = await request(app).get("/resolve").query({ link: "Hello" });
    expect(res.status).toBe(401);
  });

  it("returns 400 when link query param is missing", async () => {
    const res = await http.get("/resolve");
    expect(res.status).toBe(400);
  });
});

describe("GET /resolve-embed", () => {
  let v: TestVault;
  let app: ReturnType<typeof makeApp>;
  let http: ReturnType<typeof api>;

  beforeAll(() => {
    v = makeVault({ "_attachments/mobility-cat-cow.gif": "fake gif" });
    app = makeApp(v, { authToken: TOKEN });
    http = api(app, TOKEN);
  });

  afterAll(() => v.cleanup());

  it("rejects a request with no Authorization header", async () => {
    const res = await request(app).get("/resolve-embed").query({ link: "mobility-cat-cow.gif" });
    expect(res.status).toBe(401);
  });

  it("returns 400 when link query param is missing", async () => {
    const res = await http.get("/resolve-embed");
    expect(res.status).toBe(400);
  });
});

// `from` (the note's path) makes `link` a Markdown image's
// target, resolved relative to the note.
describe("GET /resolve-embed with from (a Markdown image)", () => {
  let v: TestVault;
  let http: ReturnType<typeof api>;

  beforeAll(() => {
    v = makeVault({
      "Notes/Sub/note.md": "# Note",
      "Notes/Sub/obrazy/picture.png": PNG_BYTES,
      "Notes/shared/pic.png": PNG_BYTES,
      "top.png": PNG_BYTES,
      // What an ![[embed]] of the same text finds: vault-wide, shortest path first.
      "pic.png": PNG_BYTES,
      "obrazy/picture.png": PNG_BYTES,
    });
    http = api(makeApp(v, { authToken: TOKEN, indexTtlMs: 0 }), TOKEN);
  });

  afterAll(() => v.cleanup());

  const resolve = async (link: string, from: string) => (await http.get("/resolve-embed", { link, from })).body;

  it("resolves relative to the note, with the file's size and version", async () => {
    const body = await resolve("obrazy/picture.png", "Notes/Sub/note.md");
    expect(body).toMatchObject({ path: "Notes/Sub/obrazy/picture.png", size: PNG_BYTES.length });
    expect(typeof body.mtimeMs).toBe("number");
    expect((await resolve("../shared/pic.png", "Notes/Sub/note.md")).path).toBe("Notes/shared/pic.png");
    expect((await resolve("my pic.png", "Notes/Sub/note.md")).path).toBeNull();
  });

  it("refuses a path out of the vault as a miss", async () => {
    expect(await resolve("../../../top.png", "Notes/Sub/note.md")).toEqual({ path: null });
    expect(await resolve("picture.png", ".obsidian/note.md")).toEqual({ path: null });
  });

  it("without from, the same link is an ![[embed]] (vault-wide)", async () => {
    const embed = async (link: string) => (await http.get("/resolve-embed", { link })).body.path;
    expect(await embed("obrazy/picture.png")).toBe("obrazy/picture.png");
    expect(await embed("../shared/pic.png")).toBe("pic.png");
    expect((await resolve("obrazy/picture.png", "Notes/Sub/note.md")).path).toBe("Notes/Sub/obrazy/picture.png");
  });
});

// A note and its images,
// written into the vault an hour after the backend's last request, opened
// with no images. The index answered every embed of the note's first open
// from the snapshot of that last request, which predated the files, so each
// one resolved as missing (and the app remembered that for the session).
// The layout is a real note's: the images in a new folder next to the
// note, the SVGs in the vault-root _attachments/, a non-ASCII note path.
describe("B-index-03: a file added after the last snapshot resolves on its first request", () => {
  const TTL_MS = 50;
  const NOTE_DIR = "Notatki/łąka";
  let v: TestVault;
  let http: ReturnType<typeof api>;

  beforeAll(async () => {
    v = makeVault({ "_attachments/old.png": PNG_BYTES, "Home.md": "# Home" });
    http = api(makeApp(v, { authToken: TOKEN, indexTtlMs: TTL_MS }), TOKEN);
    expect((await http.get("/resolve-embed", { link: "old.png" })).body.path).toBe("_attachments/old.png"); // the snapshot
    await new Promise((r) => setTimeout(r, TTL_MS * 3)); // an idle spell: the snapshot is stale
    v.put(`${NOTE_DIR}/Żółw - przykład.md`, "![[01-zdjęcie-łąki.jpg]]\n");
    v.put(`${NOTE_DIR}/obrazy/01-zdjęcie-łąki.jpg`, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    v.put(`${NOTE_DIR}/obrazy/02-zdjęcie-żółwia.jpg`, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    v.put("_attachments/mapa-łąki.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>");
  });

  afterAll(() => v.cleanup());

  it("every embed of the note, asked at once like the app does, resolves on the first round", async () => {
    const links = [
      "01-zdjęcie-łąki.jpg", // bare name, in a new subfolder next to the note
      "02-zdjęcie-żółwia.jpg|300", // a width
      "obrazy/01-zdjęcie-łąki.jpg", // a partial path
      `${NOTE_DIR}/obrazy/02-zdjęcie-żółwia.jpg`, // the full path
      "mapa-łąki.svg", // an SVG in the vault-root _attachments/
    ];
    const answers = await Promise.all(links.map((link) => http.get("/resolve-embed", { link })));
    expect(answers.map((a) => a.body.path)).toEqual([
      `${NOTE_DIR}/obrazy/01-zdjęcie-łąki.jpg`,
      `${NOTE_DIR}/obrazy/02-zdjęcie-żółwia.jpg`,
      `${NOTE_DIR}/obrazy/01-zdjęcie-łąki.jpg`,
      `${NOTE_DIR}/obrazy/02-zdjęcie-żółwia.jpg`,
      "_attachments/mapa-łąki.svg",
    ]);
    expect(answers[0].body.size).toBe(4);
  });

  it("a wikilink to the new note resolves on its first request too", async () => {
    await new Promise((r) => setTimeout(r, TTL_MS * 3));
    v.put(`${NOTE_DIR}/Powtórka - Ukształtowanie terenu.md`, "# U\n");
    const res = await http.get("/resolve", { link: "Powtórka - Ukształtowanie terenu" });
    expect(res.body.path).toBe(`${NOTE_DIR}/Powtórka - Ukształtowanie terenu.md`);
  });

  it("a link that really is missing still answers null", async () => {
    expect((await http.get("/resolve-embed", { link: "nowhere.jpg" })).body.path).toBeNull();
    expect((await http.get("/resolve", { link: "Nowhere" })).body.path).toBeNull();
  });

  // A miss waits for the rebuild; one that throws answers the
  // miss as null, not a 500.
  it("a miss whose rebuild fails answers null, not 500", async () => {
    await new Promise((r) => setTimeout(r, TTL_MS * 3));
    const bad = {
      name: "bad.md",
      isDirectory() {
        throw new Error("boom");
      },
      isFile: () => true,
      isSymbolicLink: () => false,
    } as unknown as fs.Dirent;
    const realReaddir = fs.promises.readdir.bind(fs.promises) as (dir: string, opts: { withFileTypes: true }) => Promise<fs.Dirent[]>;
    const spy = vi.spyOn(fs.promises, "readdir").mockImplementation((async (dir: string, opts: { withFileTypes: true }) => {
      const entries = await realReaddir(dir, opts);
      return dir === path.resolve(v.root) ? [bad, ...entries] : entries;
    }) as unknown as typeof fs.promises.readdir);
    try {
      const embed = await http.get("/resolve-embed", { link: "nowhere.jpg" });
      expect([embed.status, embed.body.path]).toEqual([200, null]);
      const link = await http.get("/resolve", { link: "Nowhere" });
      expect([link.status, link.body.path]).toEqual([200, null]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("GET /attachment", () => {
  let v: TestVault;
  let app: ReturnType<typeof makeApp>;
  let http: ReturnType<typeof api>;
  const gifBytes = Buffer.from("GIF89a-fake-binary-content");

  beforeAll(() => {
    v = makeVault({ "_attachments/diagram.gif": gifBytes, "_attachments/notes.txt": "not an image" });
    app = makeApp(v, { authToken: TOKEN });
    http = api(app, TOKEN);
  });

  afterAll(() => v.cleanup());

  it("rejects a request with no Authorization header or token", async () => {
    const res = await request(app).get("/attachment").query({ path: "_attachments/diagram.gif" });
    expect(res.status).toBe(401);
  });

  it("refuses the token as a ?token= query param: only the read-only ?key= goes in a URL", async () => {
    const res = await request(app)
      .get("/attachment")
      .query({ path: "_attachments/diagram.gif", token: TOKEN });
    expect(res.status).toBe(401);
  });

  it("returns the raw bytes unmodified, with the right content-type", async () => {
    const res = await http
      .get("/attachment", { path: "_attachments/diagram.gif" })
      .buffer()
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/gif");
    expect(Buffer.compare(res.body as Buffer, gifBytes)).toBe(0);
  });

  it("rejects an extension outside the image allowlist", async () => {
    const res = await http.get("/attachment", { path: "_attachments/notes.txt" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a well-formed but nonexistent path", async () => {
    const res = await http.get("/attachment", { path: "_attachments/missing.gif" });
    expect(res.status).toBe(404);
  });

  it("returns 400 for a path-traversal attempt", async () => {
    const res = await http.get("/attachment", { path: "../../etc/passwd.gif" });
    expect(res.status).toBe(400);
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

describe("attach", () => {
  freshVaultPerTest();

  const attachment = (p: string) => http.get("/attachment", { path: p });

  // An SVG on the backend's origin can run script and read the token from the URL.
  it("B-attach-01: SVG is served with a sandboxing CSP and nosniff", async () => {
    v.put("img/logo.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const res = await attachment("img/logo.svg");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^image\/svg\+xml/);
    const csp = String(res.headers["content-security-policy"] ?? "");
    expect(csp).toMatch(/default-src 'none'/);
    expect(csp).toMatch(/sandbox/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("B-attach-02: an attachment through an out-of-vault symlink is refused with 400", async () => {
    makeEscapeSymlink(v);
    const res = await attachment("escape/pic.png");
    expect(res.status).toBe(400);
  });

  it("B-attach-03: an attachment inside a dot-folder is refused with 400", async () => {
    v.put(".obsidian/plugins/x/icon.png", PNG_BYTES);
    const res = await attachment(".obsidian/plugins/x/icon.png");
    expect(res.status).toBe(400);
  });

  it("B-attach-04: an uppercase .PNG is served as image/png", async () => {
    v.put("img/SHOT.PNG", PNG_BYTES);
    const res = await attachment("img/SHOT.PNG").buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^image\/png/);
    expect(Buffer.compare(res.body as Buffer, PNG_BYTES)).toBe(0);
  });
});

// Video, PDF and SVG embeds. AVPlayer streams video with
// Range requests, so /attachment answers them (RFC 9110 §14).
describe("attach: video, PDF and byte ranges", () => {
  freshVaultPerTest();

  // 0..99, so any slice is easy to check.
  const BYTES = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
  const binary = (req: request.Test) =>
    req.buffer(true).parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => callback(null, Buffer.concat(chunks)));
    });
  const ranged = (range: string, p = "clips/clip.mp4") => binary(http.get("/attachment", { path: p }).set("Range", range));

  beforeEach(() => {
    v.put("clips/clip.mp4", BYTES);
  });

  it("B-attach-06: video and PDF types are served with their content types; WebM stays refused", async () => {
    const types: Record<string, RegExp> = {
      "a/clip.mp4": /^video\/mp4/,
      "a/clip.M4V": /^video\/x-m4v/,
      "a/clip.mov": /^video\/quicktime/,
      "a/doc.pdf": /^application\/pdf/,
    };
    for (const [p, type] of Object.entries(types)) {
      v.put(p, BYTES);
      const res = await binary(http.get("/attachment", { path: p }));
      expect(res.status, p).toBe(200);
      expect(res.headers["content-type"], p).toMatch(type);
      expect(res.headers["x-content-type-options"], p).toBe("nosniff");
      expect(Buffer.compare(res.body as Buffer, BYTES), p).toBe(0);
    }
    // iOS's AVPlayer can't play WebM, so it's refused like any other type.
    v.put("a/clip.webm", BYTES);
    expect((await http.get("/attachment", { path: "a/clip.webm" })).status).toBe(400);
  });

  it("B-attach-07: no Range → 200 with the whole file, Content-Length and Accept-Ranges", async () => {
    const res = await binary(http.get("/attachment", { path: "clips/clip.mp4" }));
    expect(res.status).toBe(200);
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-length"]).toBe("100");
    expect(res.headers["content-range"]).toBeUndefined();
  });

  it("B-attach-08: `bytes=10-19` → 206 with exactly those bytes", async () => {
    const res = await ranged("bytes=10-19");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 10-19/100");
    expect(res.headers["content-length"]).toBe("10");
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-type"]).toMatch(/^video\/mp4/);
    expect(Buffer.compare(res.body as Buffer, BYTES.subarray(10, 20))).toBe(0);
  });

  it("B-attach-09: AVPlayer's first probe, `bytes=0-1` → 206 with 2 bytes", async () => {
    const res = await ranged("bytes=0-1");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 0-1/100");
    expect(Buffer.compare(res.body as Buffer, BYTES.subarray(0, 2))).toBe(0);
  });

  it("B-attach-10: open-ended `bytes=90-` → 206 to the end", async () => {
    const res = await ranged("bytes=90-");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 90-99/100");
    expect(Buffer.compare(res.body as Buffer, BYTES.subarray(90))).toBe(0);
  });

  it("B-attach-11: suffix `bytes=-5` → 206 with the last 5 bytes", async () => {
    const res = await ranged("bytes=-5");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 95-99/100");
    expect(Buffer.compare(res.body as Buffer, BYTES.subarray(95))).toBe(0);
  });

  it("B-attach-12: an end past the file's end is clipped to the last byte", async () => {
    const res = await ranged("bytes=95-500");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 95-99/100");
    expect(Buffer.compare(res.body as Buffer, BYTES.subarray(95))).toBe(0);
  });

  it("B-attach-13: a range starting at or past the end, ending before it starts, or garbage after `bytes=` → 416 with `bytes */size`", async () => {
    for (const range of ["bytes=100-", "bytes=500-600", "bytes=50-10", "bytes=abc", "bytes=-0"]) {
      const res = await ranged(range);
      expect(res.status, range).toBe(416);
      expect(res.headers["content-range"], range).toBe("bytes */100");
    }
  });

  it("B-attach-14: a Range without `=`, another unit or several ranges → 200 with the whole file", async () => {
    for (const range of ["bytes 0-5", "items=0-5", "bytes=0-1,5-6"]) {
      const res = await ranged(range);
      expect(res.status, range).toBe(200);
      expect(res.headers["content-range"], range).toBeUndefined();
      expect(Buffer.compare(res.body as Buffer, BYTES), range).toBe(0);
    }
  });

  it("B-attach-15: ranges work on a PDF and an SVG too, and the SVG keeps its CSP", async () => {
    v.put("a/doc.pdf", BYTES);
    v.put("a/logo.svg", BYTES);
    const pdf = await ranged("bytes=0-3", "a/doc.pdf");
    expect(pdf.status).toBe(206);
    expect(pdf.headers["content-type"]).toMatch(/^application\/pdf/);
    const svg = await ranged("bytes=0-3", "a/logo.svg");
    expect(svg.status).toBe(206);
    expect(String(svg.headers["content-security-policy"])).toMatch(/sandbox/);
  });

  it("B-attach-16: with a Range, a missing video is still 404 and a dot-folder or escaping path still 400", async () => {
    expect((await ranged("bytes=0-1", "clips/gone.mp4")).status).toBe(404);
    expect((await ranged("bytes=0-1", "../outside.mp4")).status).toBe(400);
    v.put(".hidden/clip.mp4", BYTES);
    expect((await ranged("bytes=0-1", ".hidden/clip.mp4")).status).toBe(400);
  });
});

describe("resolve: sizes and versions", () => {
  freshVaultPerTest();

  const FIXTURES = path.join(__dirname, "..", "test", "fixture-vault", "Attachments");
  const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name));
  const resolveEmbed = async (link: string) => (await http.get("/resolve-embed", { link })).body;
  const mtimeOf = (rel: string) => fs.statSync(path.join(v.root, rel)).mtimeMs;
  // A PNG's signature and IHDR: all imageSize reads, the same length for any size.
  const pngHeader = (width: number, height: number) => {
    const ihdr = Buffer.alloc(25);
    ihdr.writeUInt32BE(13, 0);
    ihdr.write("IHDR", 4, "latin1");
    ihdr.writeUInt32BE(width, 8);
    ihdr.writeUInt32BE(height, 12);
    return Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), ihdr]);
  };

  it("B-resolve-12: a PNG, a GIF and a rotated JPEG get size, mtimeMs, width and height", async () => {
    v.put("a/image.png", fixture("image.png"));
    v.put("a/anim.gif", fixture("anim.gif"));
    v.put("a/rotated.jpg", fixture("rotated.jpg"));
    expect(await resolveEmbed("image.png")).toEqual({
      path: "a/image.png",
      size: fixture("image.png").length,
      mtimeMs: mtimeOf("a/image.png"),
      width: 32,
      height: 32,
    });
    expect(await resolveEmbed("anim.gif")).toEqual({
      path: "a/anim.gif",
      size: fixture("anim.gif").length,
      mtimeMs: mtimeOf("a/anim.gif"),
      width: 40,
      height: 24,
    });
    expect(await resolveEmbed("rotated.jpg")).toMatchObject({ width: 32, height: 64 });
  });

  it("B-resolve-13: a PDF or video gets size and mtimeMs only; a file /attachment doesn't serve, and a miss, the path alone", async () => {
    v.put("a/doc.pdf", "%PDF-1.4 fake");
    v.put("a/clip.mp4", "fake video");
    v.put("a/slides.pptx", "fake slides");
    expect(await resolveEmbed("doc.pdf")).toEqual({ path: "a/doc.pdf", size: 13, mtimeMs: mtimeOf("a/doc.pdf") });
    expect(await resolveEmbed("clip.mp4")).toEqual({ path: "a/clip.mp4", size: 10, mtimeMs: mtimeOf("a/clip.mp4") });
    expect(await resolveEmbed("slides.pptx")).toEqual({ path: "a/slides.pptx" });
    expect(await resolveEmbed("gone.png")).toEqual({ path: null });
  });

  it("B-resolve-14: a corrupt image gets size and mtimeMs, no width or height", async () => {
    v.put("a/broken.gif", "fake gif");
    v.put("a/empty.png", "");
    expect(await resolveEmbed("broken.gif")).toEqual({ path: "a/broken.gif", size: 8, mtimeMs: mtimeOf("a/broken.gif") });
    expect(await resolveEmbed("empty.png")).toEqual({ path: "a/empty.png", size: 0, mtimeMs: mtimeOf("a/empty.png") });
  });

  it("B-resolve-15: sizes are memoised, and read again once the file is touched", async () => {
    const full = v.put("a/pic.png", pngHeader(10, 20));
    const then = new Date("2026-01-01T00:00:00Z");
    fs.utimesSync(full, then, then);
    expect(await resolveEmbed("pic.png")).toMatchObject({ width: 10, height: 20 });
    // Same length and mtime: the memo answers, the new header isn't read.
    fs.writeFileSync(full, pngHeader(30, 40));
    fs.utimesSync(full, then, then);
    expect(await resolveEmbed("pic.png")).toMatchObject({ width: 10, height: 20 });
    const later = new Date("2026-01-02T00:00:00Z");
    fs.utimesSync(full, later, later);
    expect(await resolveEmbed("pic.png")).toEqual({ path: "a/pic.png", size: 33, mtimeMs: later.getTime(), width: 30, height: 40 });
  });

  it("B-resolve-16: the memo holds at most SIZE_MEMO_ENTRIES sizes, least recently used out first", async () => {
    expect(SIZE_MEMO_ENTRIES).toBe(10_000);
    for (const name of ["a", "b", "c"]) v.put(`${name}.png`, pngHeader(1, 1));
    const vault = openVault(v.root);
    const reads = vi.spyOn(vault, "attachmentHeader");
    const info = createAttachmentInfo(vault, 2);
    const readsFor = async (rel: string) => {
      reads.mockClear();
      expect(await info.info(rel)).toMatchObject({ width: 1, height: 1 });
      return reads.mock.calls.length;
    };
    expect(await readsFor("a.png")).toBe(1);
    expect(await readsFor("b.png")).toBe(1);
    expect(await readsFor("a.png")).toBe(0); // a is now the most recent
    expect(await readsFor("c.png")).toBe(1); // evicts b
    expect(info.memoSize()).toBe(2);
    expect(await readsFor("a.png")).toBe(0);
    expect(await readsFor("b.png")).toBe(1);
    expect(info.memoSize()).toBe(2);
  });
});
