// Device tokens and pairing. Every test runs createApp() over a throwaway vault and its
// throwaway secrets folder; a second openRegistry() on the same folder
// stands in for scripts/pair-device.sh / devices.sh editing the file on
// the host while the backend runs.

import { createHash, createHmac } from "crypto";
import { execFile, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { openRegistry, RegistryBusy, type DeviceRegistry } from "./devices";
import { api, makeApp, makeVault, ROUTES, type TestVault } from "./test-support";
import { parsePairLink } from "../shared/pair-link";

const SHARED = "shared-token-123";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");


let v: TestVault;
let secrets: string;
/** The host side: what the scripts do to the file while the backend runs. */
let host: DeviceRegistry;

beforeEach(() => {
  v = makeVault({ "Note.md": "# Note\n\n- [ ] task\n", "pic.png": PNG });
  secrets = v.secrets;
  host = openRegistry(secrets);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  v.cleanup();
});

function deviceApp(opts: { authToken?: string; publicUrl?: string; trustProxy?: string } = {}) {
  return makeApp(v, { indexTtlMs: 0, ...opts });
}

type App = ReturnType<typeof deviceApp>;

/** Pairs a device through the API with a code made on the host. */
async function pairDevice(app: App, name = "Phone"): Promise<{ deviceId: string; token: string }> {
  const { code } = await host.createPairingCode(name, "cli");
  const res = await request(app).post("/pair").send({ code, deviceName: name });
  expect(res.status).toBe(200);
  return { deviceId: res.body.deviceId, token: res.body.refreshToken };
}

function call(app: App, route: (typeof ROUTES)[number], query: Record<string, string> = {}) {
  const q = { ...(route.query ?? {}), ...query };
  return route.method === "get" ? request(app).get(route.url).query(q) : request(app).post(route.url).query(q).send(route.body ?? {});
}

describe("pairing", () => {
  it("B-devices-01: a code from the host buys a device token that opens every route", async () => {
    const app = deviceApp();
    const { code, expiresAt } = await host.createPairingCode("Phone", "cli");
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);
    const res = await request(app).post("/pair").send({ code, deviceName: "Test phone" });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["deviceId", "name", "refreshToken"]);
    expect(res.body.name).toBe("Test phone");
    expect(res.body.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const route of ROUTES) {
      const r = await call(app, route).set("Authorization", `Bearer ${res.body.refreshToken}`);
      expect(r.status, `${route.method} ${route.url}`).not.toBe(401);
      expect(r.status, `${route.method} ${route.url}`).toBeLessThan(400);
    }
  });

  it("B-devices-02: a code works once", async () => {
    const app = deviceApp();
    const { code } = await host.createPairingCode(null, "cli");
    expect((await request(app).post("/pair").send({ code })).status).toBe(200);
    const again = await request(app).post("/pair").send({ code });
    expect(again.status).toBe(401);
    expect(again.body).toEqual({ error: "invalid or expired pairing code" });
  });

  it("B-devices-03: a code expires after 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const app = deviceApp();
    const late = await host.createPairingCode(null, "cli");
    const inTime = await host.createPairingCode(null, "cli");
    vi.setSystemTime(Date.now() + 10 * 60_000 - 1000);
    expect((await request(app).post("/pair").send({ code: inTime.code })).status).toBe(200);
    vi.setSystemTime(Date.now() + 2000);
    expect((await request(app).post("/pair").send({ code: late.code })).status).toBe(401);
    // Expired codes are dropped from the file at the next write.
    await host.createPairingCode(null, "cli");
    expect(JSON.parse(fs.readFileSync(host.file, "utf-8")).pairingCodes).toHaveLength(1);
  });

  it("B-devices-04: 10 wrong codes per IP an hour, then 429 even for a good code; other IPs unaffected", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const app = deviceApp({ trustProxy: "loopback" });
    const from = (ip: string, code: string) => request(app).post("/pair").set("X-Forwarded-For", ip).send({ code });
    for (let i = 0; i < 10; i++) expect((await from("203.0.113.5", `wrong-${i}`)).status).toBe(401);
    const good = await host.createPairingCode(null, "cli");
    const blocked = await from("203.0.113.5", good.code);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(3500);
    expect(blocked.body).toEqual({ error: "too many wrong pairing codes; try again later" });
    // a missing code is a 400 and counts for nothing
    expect((await request(app).post("/pair").set("X-Forwarded-For", "198.51.100.7").send({})).status).toBe(400);
    // the code wasn't used up by the refused attempt; another IP may use it
    expect((await from("198.51.100.7", good.code)).status).toBe(200);
    // an hour after the first failure the IP may try again
    vi.setSystemTime(Date.now() + 60 * 60_000 + 1000);
    const later = await host.createPairingCode(null, "cli");
    expect((await from("203.0.113.5", later.code)).status).toBe(200);
  });

  it("B-devices-05: the device's own name wins, then the code's, then \"Unnamed device\"; names are cleaned", async () => {
    const app = deviceApp();
    const pair = async (codeName: string | null, deviceName: unknown) => {
      const { code } = await host.createPairingCode(codeName, "cli");
      return (await request(app).post("/pair").send({ code, deviceName })).body.name;
    };
    expect(await pair("iPad", "  my\u0007 iPad  ")).toBe("my iPad");
    expect(await pair("iPad", "")).toBe("iPad");
    expect(await pair(null, 42)).toBe("Unnamed device");
    expect(await pair(null, "x".repeat(100))).toHaveLength(60);
    // bidi override, zero-width space, line separator
    expect(await pair(null, "a\u202Eb\u200Bc\u2028d")).toBe("abcd");
  });

  it("B-devices-06: POST /pairing-codes from a device returns a code and a pairing link with the backend URL", async () => {
    const app = deviceApp({ publicUrl: "https://viewer.example/" });
    const { token } = await pairDevice(app);
    const res = await api(app, token).post("/pairing-codes", { name: "iPad" });
    expect(res.status).toBe(200);
    expect(res.body.link).toMatch(/^https:\/\/mdvju\.app\/pair#code=/);
    expect(parsePairLink(res.body.link)).toEqual({ code: res.body.code, backend: "https://viewer.example", name: "iPad" });
    const paired = await request(app).post("/pair").send({ code: res.body.code });
    expect(paired.status).toBe(200);
    expect(paired.body.name).toBe("iPad");
    // Without PUBLIC_URL the link names the URL the request came in on.
    const local = await api(deviceApp(), token).post("/pairing-codes");
    expect(parsePairLink(local.body.link)?.backend).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(parsePairLink(local.body.link)?.name).toBeNull();
  });
});

describe("devices", () => {
  it("B-devices-07: GET /devices lists the active devices with `current`, never a hash", async () => {
    const app = deviceApp();
    const a = await pairDevice(app, "Phone");
    const b = await pairDevice(app, "iPad");
    const c = await pairDevice(app, "Old");
    await host.revoke(c.deviceId);
    const res = await api(app, a.token).get("/devices");
    expect(res.status).toBe(200);
    expect(res.body.devices.map((d: { name: string; current: boolean }) => [d.name, d.current])).toEqual([
      ["Phone", true],
      ["iPad", false],
    ]);
    expect(Object.keys(res.body.devices[0]).sort()).toEqual(["createdAt", "current", "id", "lastSeenAt", "name", "pairedBy", "pairedByName"]);
    expect(JSON.stringify(res.body)).not.toContain(sha256(a.token));
    expect(res.body.devices.find((d: { id: string }) => d.id === b.deviceId).lastSeenAt).toBeNull();
  });

  it("B-devices-18: each device records who paired it; GET /devices shows it, with the name even after that device is revoked (review S2)", async () => {
    const app = deviceApp();
    const phone = await pairDevice(app, "Phone"); // a code from the server's CLI
    const code = (await api(app, phone.token).post("/pairing-codes", { name: "iPad" })).body.code;
    const ipad = (await request(app).post("/pair").send({ code })).body;
    // A device paired before pairedBy existed: no field in the file.
    const file = path.join(secrets, "devices.json");
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    const legacy = { ...data.devices[0], id: "0123456789ab", name: "Legacy", tokenHash: sha256("legacy-token") };
    delete legacy.pairedBy;
    data.devices.push(legacy);
    fs.writeFileSync(file, JSON.stringify(data));

    const byName = async (token: string) =>
      Object.fromEntries(
        (await api(app, token).get("/devices")).body.devices.map((d: { name: string; pairedBy: string | null; pairedByName: string | null }) => [
          d.name,
          [d.pairedBy, d.pairedByName],
        ]),
      );
    expect(await byName(ipad.refreshToken)).toEqual({
      Phone: ["cli", null],
      iPad: [phone.deviceId, "Phone"],
      Legacy: [null, null],
    });
    await host.revoke(phone.deviceId);
    expect((await byName(ipad.refreshToken)).iPad).toEqual([phone.deviceId, "Phone"]);
    expect(host.list().find((d) => d.id === ipad.deviceId)?.pairedBy).toBe(phone.deviceId);
  });

  it("B-devices-22: a device's new pairing code replaces its unused earlier one; the server's codes don't", async () => {
    const app = deviceApp();
    const phone = await pairDevice(app, "Phone");
    const first = (await api(app, phone.token).post("/pairing-codes")).body.code;
    const second = (await api(app, phone.token).post("/pairing-codes")).body.code;
    const cli1 = (await host.createPairingCode("a", "cli")).code;
    const cli2 = (await host.createPairingCode("b", "cli")).code;
    expect((await request(app).post("/pair").send({ code: first })).status).toBe(401);
    expect((await request(app).post("/pair").send({ code: second })).status).toBe(200);
    expect((await request(app).post("/pair").send({ code: cli1 })).status).toBe(200);
    expect((await request(app).post("/pair").send({ code: cli2 })).status).toBe(200);
  });

  it("B-devices-24: a re-pair that sends the old token revokes that device, its key too; other devices and the shared token stay", async () => {
    const app = deviceApp({ authToken: SHARED });
    const old = await pairDevice(app, "Phone");
    const other = await pairDevice(app, "iPad");
    const oldKey = (await api(app, old.token).get("/attachment-key")).body.key;

    // A wrong code revokes nothing, even with the old token.
    expect((await request(app).post("/pair").set("Authorization", `Bearer ${old.token}`).send({ code: "wrong" })).status).toBe(401);
    expect((await api(app, old.token).get("/status")).status).toBe(200);

    const { code } = await host.createPairingCode(null, "cli");
    const res = await request(app).post("/pair").set("Authorization", `Bearer ${old.token}`).send({ code, deviceName: "Phone" });
    expect(res.status).toBe(200);
    expect(res.body.deviceId).not.toBe(old.deviceId);
    expect((await api(app, old.token).get("/status")).status).toBe(401);
    expect((await request(app).get("/attachment").query({ path: "pic.png", key: oldKey })).status).toBe(401);
    expect((await api(app, res.body.refreshToken).get("/status")).status).toBe(200);
    expect((await api(app, other.token).get("/status")).status).toBe(200);
    expect(host.list().find((d) => d.id === old.deviceId)?.revokedAt).not.toBeNull();

    // A token that isn't an active device's (revoked, unknown, the shared
    // one) is ignored: the pairing works and nothing else is revoked.
    for (const previous of [old.token, "not-a-token", SHARED]) {
      const again = (await host.createPairingCode(null, "cli")).code;
      expect((await request(app).post("/pair").set("Authorization", `Bearer ${previous}`).send({ code: again })).status).toBe(200);
    }
    expect((await api(app, SHARED).get("/status")).status).toBe(200);
    expect((await api(app, other.token).get("/status")).status).toBe(200);
    expect(host.list().filter((d) => d.revokedAt !== null).map((d) => d.id)).toEqual([old.deviceId]);
  });

  it("B-devices-08: revoking works on the next request: token, attachment key, and the requester's own device", async () => {
    const app = deviceApp();
    const a = await pairDevice(app, "Phone");
    const b = await pairDevice(app, "iPad");
    const bKey = (await api(app, b.token).get("/attachment-key")).body.key;
    expect((await request(app).get("/attachment").query({ path: "pic.png", key: bKey })).status).toBe(200);
    expect((await request(app).delete(`/devices/${b.deviceId}`).set("Authorization", `Bearer ${a.token}`)).status).toBe(200);
    expect((await api(app, b.token).get("/status")).status).toBe(401);
    expect((await request(app).get("/attachment").query({ path: "pic.png", key: bKey })).status).toBe(401);
    // again, or an unknown id: 404
    expect((await request(app).delete(`/devices/${b.deviceId}`).set("Authorization", `Bearer ${a.token}`)).status).toBe(404);
    expect((await request(app).delete("/devices/nope").set("Authorization", `Bearer ${a.token}`)).status).toBe(404);
    // its own device
    expect((await request(app).delete(`/devices/${a.deviceId}`).set("Authorization", `Bearer ${a.token}`)).status).toBe(200);
    expect((await api(app, a.token).get("/status")).status).toBe(401);
  });

  it("B-devices-09: a revoked device can't make pairing codes; the shared token can't use the device routes", async () => {
    const app = deviceApp({ authToken: SHARED });
    const a = await pairDevice(app);
    await host.revoke(a.deviceId);
    expect((await api(app, a.token).post("/pairing-codes")).status).toBe(401);
    for (const res of [
      await api(app, SHARED).post("/pairing-codes"),
      await api(app, SHARED).get("/devices"),
      await request(app).delete(`/devices/${a.deviceId}`).set("Authorization", `Bearer ${SHARED}`),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "only a paired device can do this" });
    }
    expect((await request(app).post("/pairing-codes")).status).toBe(401);
  });

  it("B-devices-10: each device has its own attachment key, HMAC(server secret, \"attachment-v1:\" + id), for /attachment only", async () => {
    const app = deviceApp({ authToken: SHARED });
    const a = await pairDevice(app, "Phone");
    const b = await pairDevice(app, "iPad");
    const secret = fs.readFileSync(path.join(secrets, "server-secret"), "utf-8").trim();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const keyA = (await api(app, a.token).get("/attachment-key")).body.key;
    const keyB = (await api(app, b.token).get("/attachment-key")).body.key;
    expect(keyA).toBe(createHmac("sha256", secret).update(`attachment-v1:${a.deviceId}`).digest("hex"));
    expect(keyB).not.toBe(keyA);
    // the shared token still gets the shared key
    const sharedKey = createHmac("sha256", SHARED).update("attachment-v1").digest("hex");
    expect((await api(app, SHARED).get("/attachment-key")).body.key).toBe(sharedKey);
    for (const key of [keyA, keyB, sharedKey]) {
      expect((await request(app).get("/attachment").query({ path: "pic.png", key })).status).toBe(200);
      for (const route of ROUTES.filter((r) => r.url !== "/attachment")) {
        expect((await call(app, route, { key })).status, `${route.url} ?key=`).toBe(401);
        expect((await call(app, route).set("Authorization", `Bearer ${key}`)).status, `${route.url} Bearer key`).toBe(401);
      }
    }
    // a new server, same secret file: same keys (they survive a restart)
    const restarted = deviceApp();
    expect((await api(restarted, a.token).get("/attachment-key")).body.key).toBe(keyA);
  });

  it("B-devices-11: on disk only hashes: never a token or a code; devices.json 0600, server-secret 0600", async () => {
    const app = deviceApp();
    const { code } = await host.createPairingCode("Phone", "cli");
    const onDiskBefore = fs.readFileSync(host.file, "utf-8");
    expect(onDiskBefore).not.toContain(code);
    expect(onDiskBefore).toContain(sha256(code));
    const res = await request(app).post("/pair").send({ code });
    const token = res.body.refreshToken;
    const pc = await api(app, token).post("/pairing-codes");
    const onDisk = fs.readFileSync(host.file, "utf-8");
    for (const secret of [token, code, pc.body.code]) expect(onDisk).not.toContain(secret);
    expect(onDisk).toContain(sha256(token));
    expect(onDisk).toContain(sha256(pc.body.code));
    expect(fs.statSync(host.file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(secrets, "server-secret")).mode & 0o777).toBe(0o600);
  });

  it("B-devices-12: a token or pairing code never reaches the log", async () => {
    const logged: string[] = [];
    const capture = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
    for (const m of ["log", "error", "warn", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation(capture);
    const app = deviceApp({ authToken: SHARED });
    const { code } = await host.createPairingCode("Phone", "cli");
    const token = (await request(app).post("/pair").send({ code })).body.refreshToken;
    await request(app).post("/pair").send({ code }); // used: 401
    const pc = (await api(app, token).post("/pairing-codes")).body.code;
    await api(app, token).get("/status");
    await api(app, "wrong-" + token).get("/status");
    fs.writeFileSync(host.file, "{ broken"); // the malformed-file path logs
    await api(app, token).get("/status");
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) for (const secret of [token, code, pc, sha256(token)]) expect(line).not.toContain(secret);
  });

  it("B-devices-13: the file is re-read when it changes on disk: revoke, new codes and hand edits work without a restart", async () => {
    const app = deviceApp();
    const a = await pairDevice(app, "Phone");
    // pairDevice already used a code made by the "host" side; now revoke there
    await host.revoke(a.deviceId);
    expect((await api(app, a.token).get("/status")).status).toBe(401);
    // a hand edit: a device added with the hash of a token we know
    const data = JSON.parse(fs.readFileSync(host.file, "utf-8"));
    data.devices.push({ id: "handmade", name: "Hand", tokenHash: sha256("hand-token"), createdAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null });
    fs.writeFileSync(host.file, JSON.stringify(data));
    expect((await api(app, "hand-token").get("/status")).status).toBe(200);
    // the file removed: no device gets in
    fs.rmSync(host.file);
    expect((await api(app, "hand-token").get("/status")).status).toBe(401);
  });

  it("B-devices-14: a malformed devices file lets no device in and is never overwritten; the shared token still works", async () => {
    const app = deviceApp({ authToken: SHARED });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const a = await pairDevice(app);
    fs.writeFileSync(host.file, "{ not json");
    expect((await api(app, a.token).get("/status")).status).toBe(401);
    expect((await api(app, SHARED).get("/status")).status).toBe(200);
    expect((await request(app).post("/pair").send({ code: "anything" })).status).toBe(500);
    expect(fs.readFileSync(host.file, "utf-8")).toBe("{ not json");
  });

  it("B-devices-15: last seen is updated in memory per request and written to the file at most hourly", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const app = deviceApp();
    const a = await pairDevice(app);
    const stored = () => JSON.parse(fs.readFileSync(host.file, "utf-8")).devices[0].lastSeenAt;
    await api(app, a.token).get("/status");
    const first = stored();
    expect(first).not.toBeNull();
    vi.setSystemTime(Date.now() + 30 * 60_000);
    await api(app, a.token).get("/status");
    expect(stored()).toBe(first);
    const listed = (await api(app, a.token).get("/devices")).body.devices[0].lastSeenAt;
    expect(Date.parse(listed)).toBeGreaterThan(Date.parse(first));
    vi.setSystemTime(Date.now() + 31 * 60_000);
    await api(app, a.token).get("/status");
    expect(Date.parse(stored())).toBeGreaterThan(Date.parse(first));
  });
});

// iOS's URL cache kept /pair and /attachment-key responses after a sign-out.
describe("caching", () => {
  it("B-cache-01: every response says Cache-Control: no-store: /pair, /attachment-key, the other routes, device management, a 206, errors and 401s", async () => {
    const app = deviceApp();
    const { code } = await host.createPairingCode("Phone", "cli");
    const paired = await request(app).post("/pair").send({ code, deviceName: "Phone" });
    expect(paired.status).toBe(200);
    expect(paired.headers["cache-control"]).toBe("no-store");
    const wrongCode = await request(app).post("/pair").send({ code: "nope" });
    expect(wrongCode.status).toBe(401);
    expect(wrongCode.headers["cache-control"]).toBe("no-store");
    const token = paired.body.refreshToken as string;
    for (const route of ROUTES) {
      const r = await call(app, route).set("Authorization", `Bearer ${token}`);
      expect(r.status, `${route.method} ${route.url}`).toBeLessThan(400);
      expect(r.headers["cache-control"], `${route.method} ${route.url}`).toBe("no-store");
    }
    // Device management and a range response.
    const codes = await api(app, token).post("/pairing-codes", { name: "iPad" });
    expect(codes.status).toBe(200);
    expect(codes.headers["cache-control"]).toBe("no-store");
    const other = await pairDevice(app, "Other");
    const list = await api(app, token).get("/devices");
    expect(list.status).toBe(200);
    expect(list.headers["cache-control"]).toBe("no-store");
    const revoked = await request(app).delete(`/devices/${other.deviceId}`).set("Authorization", `Bearer ${token}`);
    expect(revoked.status).toBeLessThan(300);
    expect(revoked.headers["cache-control"]).toBe("no-store");
    const ranged = await api(app, token).get("/attachment", { path: "pic.png" }).set("Range", "bytes=0-3");
    expect(ranged.status).toBe(206);
    expect(ranged.headers["cache-control"]).toBe("no-store");
    const unauthorized = await request(app).get("/attachment-key");
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers["cache-control"]).toBe("no-store");
    const notFound = await api(app, token).get("/file", { path: "Missing.md" });
    expect(notFound.status).toBe(404);
    expect(notFound.headers["cache-control"]).toBe("no-store");
  });
});

// AUTH_TOKEN set = the transition (shared token and device
// tokens both work); unset = device tokens only, and ?token= is gone.
describe("transition switch", () => {
  it("B-auth-13: with AUTH_TOKEN, the shared token and its key work next to device tokens; ?token= doesn't", async () => {
    const app = deviceApp({ authToken: SHARED });
    const a = await pairDevice(app);
    expect((await api(app, SHARED).get("/status")).status).toBe(200);
    expect((await api(app, a.token).get("/status")).status).toBe(200);
    const sharedKey = (await api(app, SHARED).get("/attachment-key")).body.key;
    expect((await request(app).get("/attachment").query({ path: "pic.png", key: sharedKey })).status).toBe(200);
    expect((await request(app).get("/attachment").query({ path: "pic.png", token: SHARED })).status).toBe(401);
  });

  it("B-auth-14: without AUTH_TOKEN only device tokens work: the old shared token and ?token= get 401 on every route", async () => {
    const app = deviceApp();
    const a = await pairDevice(app);
    const aKey = (await api(app, a.token).get("/attachment-key")).body.key;
    const oldKey = createHmac("sha256", SHARED).update("attachment-v1").digest("hex");
    for (const route of ROUTES) {
      expect((await call(app, route).set("Authorization", `Bearer ${SHARED}`)).status, route.url).toBe(401);
      expect((await call(app, route).set("Authorization", "Bearer ")).status, route.url).toBe(401);
      for (const token of [SHARED, a.token, aKey, ""]) {
        expect((await call(app, route, { token })).status, `${route.url} ?token=`).toBe(401);
      }
    }
    expect((await request(app).get("/attachment").query({ path: "pic.png", key: oldKey })).status).toBe(401);
    expect((await request(app).get("/attachment").query({ path: "pic.png", key: aKey })).status).toBe(200);
  });

  it("B-auth-15: a device token never works in the URL, as ?token= or ?key=", async () => {
    const app = deviceApp({ authToken: SHARED });
    const a = await pairDevice(app);
    for (const route of ROUTES) {
      expect((await call(app, route, { token: a.token })).status, `${route.url} ?token=`).toBe(401);
      expect((await call(app, route, { key: a.token })).status, `${route.url} ?key=`).toBe(401);
    }
  });
});

// The entry points, run as processes: server.ts's startup rule and the CLI
// the scripts use, editing the file a running backend serves from.
describe("startup and CLI", () => {
  const run = promisify(execFile);
  const tsNode = (script: string, args: string[], env: Record<string, string>) =>
    run(path.join(__dirname, "..", "node_modules", ".bin", "ts-node"), ["--transpile-only", script, ...args], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, ...env },
      timeout: 30_000,
    });

  it("B-devices-16: the server refuses to start with neither AUTH_TOKEN nor a devices file, and starts with the file alone", async () => {
    const env = { VAULT_ROOT: v.root, SECRETS_DIR: secrets, AUTH_TOKEN: "", PORT: "0", PUBLIC_URL: "https://viewer.example" };
    const refused = await tsNode("src/server.ts", [], env).then(
      () => null,
      (err) => err,
    );
    expect(refused?.code).toBe(1);
    expect(refused?.stderr).toMatch(/Neither AUTH_TOKEN nor .*devices\.json/);

    await host.createPairingCode(null, "cli"); // creates the file
    const child = require("child_process").spawn(path.join(__dirname, "..", "node_modules", ".bin", "ts-node"), ["--transpile-only", "src/server.ts"], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, ...env },
    });
    try {
      const out = await new Promise<string>((resolve, reject) => {
        let text = "";
        const timer = setTimeout(() => reject(new Error(`no start: ${text}`)), 20_000);
        child.stdout.on("data", (d: Buffer) => {
          text += d.toString();
          if (text.includes("auth:")) {
            clearTimeout(timer);
            resolve(text);
          }
        });
        child.on("exit", () => reject(new Error(`exited: ${text}`)));
      });
      expect(out).toMatch(/auth: device tokens \(.*\) only/);
      expect(fs.existsSync(path.join(secrets, "server-secret"))).toBe(true);
    } finally {
      child.kill();
    }
  }, 60_000);

  it("B-devices-21: the server refuses to start without a PUBLIC_URL, or with one that isn't a plain http(s) URL", async () => {
    await host.createPairingCode(null, "cli");
    for (const PUBLIC_URL of ["", "viewer.example", "https://mdvju.app@evil.example", "https://viewer.example/?x=1"]) {
      const env = { VAULT_ROOT: v.root, SECRETS_DIR: secrets, AUTH_TOKEN: "", PORT: "0", PUBLIC_URL };
      const refused = await tsNode("src/server.ts", [], env).then(
        () => null,
        (err) => err,
      );
      expect(refused?.code, PUBLIC_URL).toBe(1);
      expect(refused?.stderr).toMatch(/PUBLIC_URL must be/);
    }
  }, 60_000);

  it("B-devices-23: the server refuses to start without VAULT_ROOT: there's no default, so it never falls back to the live vault", async () => {
    await host.createPairingCode(null, "cli");
    for (const VAULT_ROOT of ["", "  "]) {
      const env = { VAULT_ROOT, SECRETS_DIR: secrets, AUTH_TOKEN: "", PORT: "0", PUBLIC_URL: "https://viewer.example" };
      const refused = await tsNode("src/server.ts", [], env).then(
        () => null,
        (err) => err,
      );
      expect(refused?.code, JSON.stringify(VAULT_ROOT)).toBe(1);
      expect(refused?.stderr).toMatch(/VAULT_ROOT is not set/);
    }
  }, 60_000);

  it("B-devices-17: the CLI pairs, lists, rotates and revokes on the file a running backend uses", async () => {
    const app = deviceApp();
    const env = { SECRETS_DIR: secrets, PUBLIC_URL: "https://viewer.example" };
    const link = (await tsNode("src/devices-cli.ts", ["pair", "admin-cli"], env)).stdout.trim();
    const parsed = parsePairLink(link);
    expect(parsed).toMatchObject({ backend: "https://viewer.example", name: "admin-cli" });
    const paired = await request(app).post("/pair").send({ code: parsed!.code });
    expect(paired.status).toBe(200);
    const token = paired.body.refreshToken;

    const list = (await tsNode("src/devices-cli.ts", ["list"], env)).stdout;
    expect(list).toContain(paired.body.deviceId);
    expect(list).toContain("admin-cli");
    expect(list).not.toContain(token);

    const rotated = await tsNode("src/devices-cli.ts", ["rotate", paired.body.deviceId], env);
    expect((await api(app, token).get("/status")).status).toBe(401);
    const again = await request(app).post("/pair").send({ code: parsePairLink(rotated.stdout.trim())!.code });
    expect(again.body.name).toBe("admin-cli");

    await tsNode("src/devices-cli.ts", ["revoke", again.body.deviceId], env);
    expect((await api(app, again.body.refreshToken).get("/status")).status).toBe(401);

    const qr = (await tsNode("src/devices-cli.ts", ["qr", link], env)).stdout;
    expect(qr.split("\n").length).toBeGreaterThan(20);
  }, 60_000);

  it("B-devices-19: a CLI revoke during the backend's read-change-write waits for it and isn't lost (review S1, interleaving forced)", async () => {
    const app = deviceApp();
    const x = await pairDevice(app, "Revoked by the app");
    const y = await pairDevice(app, "Revoked by the CLI");
    // The backend's side of the race: its revoke (any API write, or the
    // hourly last-seen write) reads the file, and while it holds that copy
    // the CLI is started and must reach the point where it waits for the
    // lock. Without the lock it wrote its revoke there, and the backend's
    // rename then put y back.
    const errFile = path.join(secrets, "cli.out");
    let child: ReturnType<typeof spawn> | null = null;
    let armed = true;
    const server = openRegistry(secrets, () => {
      if (armed) {
        armed = false;
        const err = fs.openSync(errFile, "w");
        child = spawn(path.join(__dirname, "..", "node_modules", ".bin", "ts-node"), ["--transpile-only", "src/devices-cli.ts", "revoke", y.deviceId], {
          cwd: path.join(__dirname, ".."),
          env: { ...process.env, SECRETS_DIR: secrets },
          stdio: ["ignore", err, err],
        });
        fs.closeSync(err);
        const deadline = Date.now() + 40_000;
        // Until it waits for the lock, or (without one) has written its revoke.
        while (!/waiting|revoked/.test(fs.readFileSync(errFile, "utf-8"))) {
          if (Date.now() > deadline) throw new Error(`the CLI never waited for the lock: ${fs.readFileSync(errFile, "utf-8")}`);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
      }
      return Date.now();
    });
    expect(await server.revoke(x.deviceId)).not.toBeNull();
    expect(child).not.toBeNull();
    const exit = await new Promise<number | null>((resolve) => child!.on("exit", resolve));
    expect(exit, fs.readFileSync(errFile, "utf-8")).toBe(0);
    const revoked = Object.fromEntries(host.list().map((d) => [d.name, d.revokedAt !== null]));
    expect(revoked).toEqual({ "Revoked by the app": true, "Revoked by the CLI": true });
    expect((await api(app, y.token).get("/status")).status).toBe(401);
    expect(fs.existsSync(path.join(secrets, "devices.json.lock"))).toBe(false);
  }, 60_000);

  it("B-devices-25: two writers that find the same stale lock break it once: the later one leaves the new lock alone", async () => {
    const lock = path.join(secrets, "devices.json.lock");
    await host.createPairingCode(null, "cli");
    fs.writeFileSync(lock, "");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    vi.spyOn(console, "error").mockImplementation(() => {});
    let freshIno = 0;
    const late = openRegistry(secrets, undefined, {
      lockTimeoutMs: 300,
      // Between this writer's stat and its break, another writer broke the
      // same stale lock and took the lock itself.
      beforeStaleBreak: () => {
        if (freshIno !== 0) return;
        fs.rmSync(lock);
        fs.writeFileSync(lock, "", { flag: "wx" });
        freshIno = fs.statSync(lock).ino;
      },
    });
    // The other writer still holds its lock, so this one waits and gives up.
    await expect(Promise.resolve().then(() => late.createPairingCode("x", "cli"))).rejects.toThrow(RegistryBusy);
    expect(freshIno).not.toBe(0);
    expect(fs.statSync(lock).ino).toBe(freshIno);
    expect(fs.readdirSync(secrets).filter((f) => f.startsWith("devices.json.lock")).sort()).toEqual(["devices.json.lock"]);
  });

  it("B-devices-27: a writer that lost its lock writes nothing and leaves the new holder's lock alone", async () => {
    const lock = path.join(secrets, "devices.json.lock");
    const app = deviceApp();
    const a = await pairDevice(app, "Phone");
    const before = fs.readFileSync(path.join(secrets, "devices.json"), "utf-8");
    let armed = true;
    // Inside the read-change-write: this writer's lock is broken (as if
    // stale) and another writer takes the lock.
    const late = openRegistry(secrets, () => {
      if (armed) {
        armed = false;
        fs.rmSync(lock);
        fs.writeFileSync(lock, "other writer", { flag: "wx" });
      }
      return Date.now();
    });
    await expect(late.revoke(a.deviceId)).rejects.toThrow(RegistryBusy);
    expect(fs.readFileSync(path.join(secrets, "devices.json"), "utf-8")).toBe(before);
    expect(fs.readFileSync(lock, "utf-8")).toBe("other writer");
    expect((await api(app, a.token).get("/status")).status).toBe(200);
  });

  it("B-devices-26: waiting for the lock doesn't block the event loop", async () => {
    const lock = path.join(secrets, "devices.json.lock");
    await host.createPairingCode(null, "cli");
    fs.writeFileSync(lock, "");
    const waiting = openRegistry(secrets, undefined, { lockTimeoutMs: 2_000 });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    try {
      const write = Promise.resolve().then(() => waiting.createPairingCode("x", "cli"));
      await new Promise((r) => setTimeout(r, 200));
      // Timers ran while the writer waited; a busy-wait would have held them all back.
      expect(ticks).toBeGreaterThanOrEqual(5);
      fs.rmSync(lock);
      expect((await write).code).toBeTruthy();
    } finally {
      clearInterval(timer);
    }
  });

  it("B-devices-20: a writer that can't get the lock fails without writing; a stale lock (its writer died) is removed", async () => {
    const lock = path.join(secrets, "devices.json.lock");
    await host.createPairingCode(null, "cli");
    const before = fs.readFileSync(path.join(secrets, "devices.json"), "utf-8");
    fs.writeFileSync(lock, "");
    const waits: number[] = [];
    const impatient = openRegistry(secrets, undefined, { lockTimeoutMs: 100, onLockWait: () => waits.push(1) });
    await expect(impatient.createPairingCode("x", "cli")).rejects.toThrow(RegistryBusy);
    expect(waits).toEqual([1]);
    expect(fs.readFileSync(path.join(secrets, "devices.json"), "utf-8")).toBe(before);
    expect(fs.existsSync(lock)).toBe(true);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await impatient.createPairingCode("x", "cli")).code).toBeTruthy();
    expect(fs.existsSync(lock)).toBe(false);
  });
});
