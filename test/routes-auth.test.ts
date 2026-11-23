// Auth on every route, GET /status and CORS. Every test runs against
// createApp() over a throwaway temp vault (makeVault).
//
// Tests named with a B- ID pin the API's behaviour. Where the backend is
// still wrong, the test is `it.fails`. When the fix lands, vitest
// reports the `it.fails` test as failing -- flip it to `it`.

import { createHmac } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { api, DEVICE_ROUTES, makeApp, makeVault, OPEN_ROUTES, ROUTES, type TestVault } from "./support";

const TOKEN = "test-token-123";
// The attachment key, computed here independently of server.ts.
const KEY = createHmac("sha256", TOKEN).update("attachment-v1").digest("hex");
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("GET /status", () => {
  let v: TestVault;
  let app: ReturnType<typeof makeApp>;

  beforeAll(() => {
    v = makeVault();
    app = makeApp(v, { authToken: TOKEN });
  });

  afterAll(() => v.cleanup());

  it("rejects a request with no Authorization header", async () => {
    const res = await request(app).get("/status");
    expect(res.status).toBe(401);
  });

  it("returns a numeric apiVersion for a valid token", async () => {
    const res = await api(app, TOKEN).get("/status");
    expect(res.status).toBe(200);
    expect(typeof res.body.apiVersion).toBe("number");
  });
});

// The route tables (test/support.ts) list every route the app registers,
// so a new route can't miss the auth tests below and in devices.test.ts.
it("ROUTES, DEVICE_ROUTES and OPEN_ROUTES are exactly the registered routes", () => {
  const v = makeVault();
  const app = makeApp(v);
  type Layer = { route?: { path: string; methods: Record<string, boolean> } };
  const registered = (app._router.stack as Layer[])
    .flatMap((layer) => (layer.route ? Object.keys(layer.route.methods).map((m) => `${m} ${layer.route!.path}`) : []))
    .sort();
  v.cleanup();
  expect(registered).toEqual([...ROUTES, ...DEVICE_ROUTES, ...OPEN_ROUTES].map((r) => `${r.method} ${r.url}`).sort());
});


describe("auth", () => {
  let v: TestVault;
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    v = makeVault({ "Note.md": "# Note\n\n- [ ] task\n", "pic.png": PNG_BYTES });
    app = makeApp(v, { authToken: TOKEN });
  });

  afterEach(() => v.cleanup());

  function send(route: (typeof ROUTES)[number], extraQuery: Record<string, string> = {}) {
    const query = { ...(route.query ?? {}), ...extraQuery };
    const r = request(app);
    return route.method === "get" ? r.get(route.url).query(query) : r.post(route.url).query(query).send(route.body ?? {});
  }

  // The body was parsed before auth, and a parse error came
  // back as Express's HTML page with a stack trace.
  it("B-auth-05: a bad JSON body gets JSON errors only: 401 without a token, 400 with one", async () => {
    const unauthed = await request(app).post("/home").set("Content-Type", "application/json").send("{not json");
    expect(unauthed.status).toBe(401);
    expect(unauthed.headers["content-type"]).toMatch(/application\/json/);
    const authed = await api(app, TOKEN).post("/home").set("Content-Type", "application/json").send("{not json");
    expect(authed.status).toBe(400);
    expect(authed.headers["content-type"]).toMatch(/application\/json/);
    expect(authed.text).not.toMatch(/at .*\.js/);
  });

  it.each(ROUTES.map((r) => [`${r.method.toUpperCase()} ${r.url}`, r] as const))(
    "B-auth-01: %s returns 401 JSON with no token and with a wrong token",
    async (_label, route) => {
      const none = await send(route);
      expect(none.status).toBe(401);
      expect(none.body).toEqual({ error: "unauthorized" });

      const wrong = await send(route).set("Authorization", "Bearer not-the-token");
      expect(wrong.status).toBe(401);
      expect(wrong.body).toEqual({ error: "unauthorized" });
    },
  );

  // A query token is refused on every POST.
  const posts = ROUTES.filter((r) => r.method === "post");
  it.each(posts.map((r) => [`POST ${r.url}`, r] as const))(
    "B-auth-02: ?token= on %s is refused with 401",
    async (_label, route) => {
      const before = v.read("Note.md");
      const res = await send(route, { token: TOKEN });
      expect(res.status).toBe(401);
      expect(v.read("Note.md")).toBe(before);
    },
  );

  // Only GET /attachment takes ?token= (images can't send headers).
  const nonAttachmentGets = ROUTES.filter((r) => r.method === "get" && r.url !== "/attachment");
  it.each(nonAttachmentGets.map((r) => [`GET ${r.url}`, r] as const))(
    "B-auth-03: ?token= on %s is refused with 401",
    async (_label, route) => {
      const res = await send(route, { token: TOKEN });
      expect(res.status).toBe(401);
    },
  );

  // The write-capable token is refused in an
  // image URL too; ?key= (the read-only attachment key) is the only URL credential.
  it("B-auth-04: ?token= on GET /attachment is refused with 401, also with a Range header", async () => {
    expect((await request(app).get("/attachment").query({ path: "pic.png", token: TOKEN })).status).toBe(401);
    expect((await request(app).get("/attachment").query({ path: "pic.png", token: TOKEN }).set("Range", "bytes=0-1")).status).toBe(401);
  });
});

// Image URLs carry a read-only key derived from the token, not the token.
describe("attachment key", () => {
  let v: TestVault;
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    v = makeVault({ "Note.md": "# Note\n\n- [ ] task\n", "pic.png": PNG_BYTES });
    app = makeApp(v, { authToken: TOKEN });
  });

  afterEach(() => v.cleanup());

  it("B-auth-06: GET /attachment-key returns the hex HMAC-SHA256 of \"attachment-v1\" keyed with the token", async () => {
    const res = await api(app, TOKEN).get("/attachment-key");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ key: KEY });
    expect(KEY).toMatch(/^[0-9a-f]{64}$/);
  });

  it("B-auth-07: ?key= on GET /attachment is accepted", async () => {
    const res = await request(app).get("/attachment").query({ path: "pic.png", key: KEY });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^image\/png/);
  });

  it("B-auth-08: a wrong or empty ?key= on GET /attachment is refused with 401", async () => {
    for (const key of ["not-the-key", "", TOKEN, KEY.toUpperCase()]) {
      const res = await request(app).get("/attachment").query({ path: "pic.png", key });
      expect(res.status, `key=${key}`).toBe(401);
    }
  });

  // The key opens /attachment and nothing else: not as ?key=, not as
  // ?token=, not as a Bearer header, and never a write.
  const others = ROUTES.filter((r) => r.url !== "/attachment");
  it.each(others.map((r) => [`${r.method.toUpperCase()} ${r.url}`, r] as const))(
    "B-auth-09: the key on %s is refused with 401",
    async (_label, route) => {
      const before = v.read("Note.md");
      const query = route.query ?? {};
      const call = (q: Record<string, string>) =>
        route.method === "get" ? request(app).get(route.url).query(q) : request(app).post(route.url).query(q).send(route.body ?? {});
      expect((await call({ ...query, key: KEY })).status).toBe(401);
      expect((await call({ ...query, token: KEY })).status).toBe(401);
      expect((await call(query).set("Authorization", `Bearer ${KEY}`)).status).toBe(401);
      expect(v.read("Note.md")).toBe(before);
    },
  );

  it("B-auth-10: the key works only as ?key= on /attachment, not as ?token= or a Bearer header", async () => {
    expect((await request(app).get("/attachment").query({ path: "pic.png", token: KEY })).status).toBe(401);
    expect((await request(app).get("/attachment").query({ path: "pic.png" }).set("Authorization", `Bearer ${KEY}`)).status).toBe(401);
  });

  it("B-auth-11: rotating the token rotates the key; the old key stops working", async () => {
    const rotated = makeApp(v, { authToken: "rotated-token" });
    const res = await api(rotated, "rotated-token").get("/attachment-key");
    expect(res.body.key).not.toBe(KEY);
    expect((await request(rotated).get("/attachment").query({ path: "pic.png", key: KEY })).status).toBe(401);
    expect((await request(rotated).get("/attachment").query({ path: "pic.png", key: res.body.key })).status).toBe(200);
  });

  // AVPlayer and the PDF download fetch these with the key URL.
  it("B-auth-12: video, PDF and SVG open with ?key= (whole or ranged); not with ?token=, nor without a credential", async () => {
    for (const p of ["clip.mp4", "clip.mov", "doc.pdf", "logo.svg"]) v.put(p, PNG_BYTES);
    for (const p of ["clip.mp4", "clip.mov", "doc.pdf", "logo.svg"]) {
      expect((await request(app).get("/attachment").query({ path: p, key: KEY })).status, p).toBe(200);
      expect((await request(app).get("/attachment").query({ path: p, key: KEY }).set("Range", "bytes=0-1")).status, p).toBe(206);
      expect((await request(app).get("/attachment").query({ path: p, token: TOKEN })).status, p).toBe(401);
      expect((await request(app).get("/attachment").query({ path: p }).set("Range", "bytes=0-1")).status, p).toBe(401);
      expect((await request(app).get("/attachment").query({ path: p, key: "wrong" })).status, p).toBe(401);
    }
  });
});

// CORS is off unless CORS_ORIGIN names an
// origin; the native app sends no Origin and needs none.
describe("CORS", () => {
  it("B-cors-01: no CORS_ORIGIN, no Access-Control-Allow-Origin, also on a preflight", async () => {
    const v = makeVault();
    const app = makeApp(v, { authToken: TOKEN });
    const res = await api(app, TOKEN).get("/file", { path: "Nonexistent.md" }).set("Origin", "https://evil.example");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    const pre = await request(app).options("/file").set("Origin", "https://evil.example").set("Access-Control-Request-Method", "GET");
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
    v.cleanup();
  });

  it("B-cors-02: with CORS_ORIGIN, that origin is allowed, and only that one", async () => {
    const v = makeVault();
    const app = makeApp(v, { authToken: TOKEN, corsOrigin: "http://localhost:8081" });
    const res = await api(app, TOKEN).get("/file", { path: "Nonexistent.md" }).set("Origin", "http://localhost:8081");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:8081");
    const other = await api(app, TOKEN).get("/file", { path: "Nonexistent.md" }).set("Origin", "https://evil.example");
    expect(other.headers["access-control-allow-origin"]).not.toBe("https://evil.example");
    expect(other.headers["access-control-allow-origin"]).not.toBe("*");
    v.cleanup();
  });
});

// The container's healthcheck asks the server itself, so a
// server that answers 500 to everything, or has lost its vault mount, is
// unhealthy.
describe("GET /health", () => {
  it("B-health-01: no credential needed; 200 {ok: true} while the vault has entries, 503 when it's empty or gone; nothing else in it", async () => {
    const v = makeVault({ "Note.md": "# Note\n" });
    const app = makeApp(v, { authToken: TOKEN });
    const ok = await request(app).get("/health");
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    expect(ok.headers["cache-control"]).toBe("no-store");
    fs.rmSync(path.join(v.root, "Note.md"));
    const empty = await request(app).get("/health");
    expect(empty.status).toBe(503);
    expect(empty.body).toEqual({ error: "vault is empty or unreadable" });
    fs.rmSync(v.root, { recursive: true });
    expect((await request(app).get("/health")).status).toBe(503);
    // Only GET; a credential in the URL is still refused elsewhere.
    expect((await request(app).post("/health")).status).toBe(401);
    expect((await request(app).get("/status")).status).toBe(401);
    v.cleanup();
  });
});
