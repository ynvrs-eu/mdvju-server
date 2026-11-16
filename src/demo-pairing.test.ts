// The demo server's reusable pairing code: DEMO_PAIRING_CODE until
// DEMO_PAIRING_EXPIRES, any number of uses, each a new device marked
// `demo`, at most DEMO_MAX_DEVICES of them (oldest revoked first). Off,
// and the server as before, unless both variables are set.

import * as crypto from "crypto";
import { execFile, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { openRegistry, parseDemoPairing, type DemoPairing, type DeviceRegistry } from "./devices";
import { api, makeApp, makeVault, ROUTES, type TestVault } from "./test-support";
import { parsePairLink } from "../shared/pair-link";

// Delegates to the real one; B-devices-35 checks what it's called with.
vi.mock("crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("crypto")>();
  return { ...real, timingSafeEqual: vi.fn(real.timingSafeEqual) };
});

const CODE = "dGhpcy1pcy1hLWRlbW8tY29kZS0yNGI"; // 23 bytes of base64url
const DAY = 24 * 60 * 60_000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let v: TestVault;
let host: DeviceRegistry;

beforeEach(() => {
  v = makeVault({ "Note.md": "# Note\n\n- [ ] task\n", "pic.png": PNG });
  host = openRegistry(v.secrets);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  v.cleanup();
});

function demo(over: Partial<DemoPairing> = {}): DemoPairing {
  return { code: CODE, expiresAt: Date.now() + 30 * DAY, maxDevices: 20, ...over };
}

function demoApp(demoPairing: DemoPairing | null, opts: { trustProxy?: string; authToken?: string } = {}) {
  return makeApp(v, { indexTtlMs: 0, demoPairing, ...opts });
}

const fileDevices = () => JSON.parse(fs.readFileSync(host.file, "utf-8")).devices as { id: string; name: string; revokedAt: string | null; demo?: true; pairedBy: string | null }[];

describe("parseDemoPairing", () => {
  it("B-devices-28: off when either variable is unset or empty; set but invalid throws, never with the code in the message", () => {
    expect(parseDemoPairing({})).toBeNull();
    expect(() => parseDemoPairing({ DEMO_PAIRING_CODE: CODE })).toThrow(/together \(only one is set\)/);
    expect(() => parseDemoPairing({ DEMO_PAIRING_EXPIRES: "2026-12-15" })).toThrow(/together/);
    expect(() => parseDemoPairing({ DEMO_PAIRING_CODE: " ", DEMO_PAIRING_EXPIRES: "2026-12-15" })).toThrow(/together/);
    expect(parseDemoPairing({ DEMO_PAIRING_CODE: " ", DEMO_PAIRING_EXPIRES: "" })).toBeNull();
    // Off: DEMO_MAX_DEVICES isn't even looked at.
    expect(parseDemoPairing({ DEMO_MAX_DEVICES: "nonsense" })).toBeNull();

    expect(parseDemoPairing({ DEMO_PAIRING_CODE: CODE, DEMO_PAIRING_EXPIRES: "2026-12-15" })).toEqual({
      code: CODE,
      expiresAt: Date.parse("2026-12-15T00:00:00Z"),
      maxDevices: 20,
    });
    expect(parseDemoPairing({ DEMO_PAIRING_CODE: CODE, DEMO_PAIRING_EXPIRES: "2026-12-15T12:30:00+01:00", DEMO_MAX_DEVICES: "5" })).toEqual({
      code: CODE,
      expiresAt: Date.parse("2026-12-15T11:30:00Z"),
      maxDevices: 5,
    });

    const bad: [Record<string, string>, RegExp][] = [
      [{ DEMO_PAIRING_CODE: "short", DEMO_PAIRING_EXPIRES: "2026-12-15" }, /DEMO_PAIRING_CODE must be base64url of at least 16/],
      [{ DEMO_PAIRING_CODE: "AAAAAAAAAAAAAAAAAAAA", DEMO_PAIRING_EXPIRES: "2026-12-15" }, /DEMO_PAIRING_CODE/], // 15 bytes
      [{ DEMO_PAIRING_CODE: CODE + "+/", DEMO_PAIRING_EXPIRES: "2026-12-15" }, /DEMO_PAIRING_CODE/], // base64, not base64url
      [{ DEMO_PAIRING_CODE: CODE + "=", DEMO_PAIRING_EXPIRES: "2026-12-15" }, /DEMO_PAIRING_CODE/],
      [{ DEMO_PAIRING_CODE: CODE, DEMO_PAIRING_EXPIRES: "next month" }, /DEMO_PAIRING_EXPIRES must be an ISO date/],
      [{ DEMO_PAIRING_CODE: CODE, DEMO_PAIRING_EXPIRES: "15.12.2026" }, /DEMO_PAIRING_EXPIRES/],
      [{ DEMO_PAIRING_CODE: CODE, DEMO_PAIRING_EXPIRES: "2026-13-45" }, /DEMO_PAIRING_EXPIRES/],
      [{ DEMO_PAIRING_CODE: CODE, DEMO_PAIRING_EXPIRES: "1765756800000" }, /DEMO_PAIRING_EXPIRES/],
      [{ DEMO_PAIRING_CODE: CODE, DEMO_PAIRING_EXPIRES: "2026-12-15", DEMO_MAX_DEVICES: "0" }, /DEMO_MAX_DEVICES/],
      [{ DEMO_PAIRING_CODE: CODE, DEMO_PAIRING_EXPIRES: "2026-12-15", DEMO_MAX_DEVICES: "2.5" }, /DEMO_MAX_DEVICES/],
      [{ DEMO_PAIRING_CODE: CODE, DEMO_PAIRING_EXPIRES: "2026-12-15", DEMO_MAX_DEVICES: "-1" }, /DEMO_MAX_DEVICES/],
      [{ DEMO_PAIRING_CODE: CODE, DEMO_PAIRING_EXPIRES: "2026-12-15", DEMO_MAX_DEVICES: "ten" }, /DEMO_MAX_DEVICES/],
    ];
    for (const [env, message] of bad) {
      let thrown: Error | null = null;
      try {
        parseDemoPairing(env);
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown?.message, JSON.stringify(env)).toMatch(message);
      expect(thrown?.message).not.toContain(env.DEMO_PAIRING_CODE);
    }
  });
});

describe("pairing with the demo code", () => {
  it("B-devices-30: the code pairs any number of times, each a new demo device with its own token, \"Demo <n>\" unless named; the code stays usable", async () => {
    const app = demoApp(demo());
    const tokens: string[] = [];
    const names: string[] = [];
    for (const deviceName of [undefined, undefined, "Reviewer iPad", undefined]) {
      const res = await request(app).post("/pair").send({ code: CODE, ...(deviceName ? { deviceName } : {}) });
      expect(res.status).toBe(200);
      tokens.push(res.body.refreshToken);
      names.push(res.body.name);
    }
    expect(names).toEqual(["Demo 1", "Demo 2", "Reviewer iPad", "Demo 4"]);
    expect(new Set(tokens).size).toBe(4);
    for (const token of tokens) expect((await api(app, token).get("/file").query({ path: "Note.md" })).status).toBe(200);
    const stored = fileDevices();
    expect(stored).toHaveLength(4);
    for (const d of stored) expect(d).toMatchObject({ demo: true, pairedBy: "cli", revokedAt: null });
    // Nothing about the demo code is stored: it's not a pairing code in the file.
    const raw = fs.readFileSync(host.file, "utf-8");
    expect(JSON.parse(raw).pairingCodes).toEqual([]);
    expect(raw).not.toContain(CODE);
    expect(raw).not.toContain(crypto.createHash("sha256").update(CODE).digest("hex"));
  });

  it("B-devices-38: a re-pair with the demo code revokes the device whose token it sends", async () => {
    const app = demoApp(demo());
    const first = (await request(app).post("/pair").send({ code: CODE })).body;
    const second = await request(app).post("/pair").set("Authorization", `Bearer ${first.refreshToken}`).send({ code: CODE });
    expect(second.status).toBe(200);
    expect((await api(app, first.refreshToken).get("/status")).status).toBe(401);
    expect((await api(app, second.body.refreshToken).get("/status")).status).toBe(200);
  });

  it("B-devices-31: from DEMO_PAIRING_EXPIRES on, the code gets the same 401 as a wrong code, and counts against the rate limit", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const expiresAt = Date.now() + DAY;
    const app = demoApp(demo({ expiresAt }), { trustProxy: "loopback" });
    vi.setSystemTime(expiresAt - 1);
    expect((await request(app).post("/pair").send({ code: CODE })).status).toBe(200);
    vi.setSystemTime(expiresAt);
    const expired = await request(app).post("/pair").set("X-Forwarded-For", "203.0.113.9").send({ code: CODE });
    const wrong = await request(app).post("/pair").set("X-Forwarded-For", "203.0.113.10").send({ code: "not-the-code-at-all-xxxxxx" });
    expect(expired.status).toBe(401);
    expect(expired.body).toEqual(wrong.body);
    expect(expired.body).toEqual({ error: "invalid or expired pairing code" });
    expect(expired.headers["content-type"]).toBe(wrong.headers["content-type"]);
    for (let i = 0; i < 9; i++) await request(app).post("/pair").set("X-Forwarded-For", "203.0.113.9").send({ code: CODE });
    expect((await request(app).post("/pair").set("X-Forwarded-For", "203.0.113.9").send({ code: CODE })).status).toBe(429);
    // A device paired before the expiry keeps working: the expiry only stops new pairings.
    expect(fileDevices().filter((d) => d.revokedAt === null)).toHaveLength(1);
  });

  it("B-devices-32: past DEMO_MAX_DEVICES the oldest demo devices are revoked first; other devices aren't counted or revoked", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const app = demoApp(demo({ maxDevices: 3 }));
    const { code } = await host.createPairingCode("Owner's phone", "cli");
    const owner = (await request(app).post("/pair").send({ code })).body.refreshToken;
    const demoTokens: string[] = [];
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(Date.now() + 1000);
      demoTokens.push((await request(app).post("/pair").send({ code: CODE })).body.refreshToken);
    }
    const status = async (token: string) => (await api(app, token).get("/status")).status;
    expect(await Promise.all(demoTokens.map(status))).toEqual([401, 401, 200, 200, 200]);
    expect(await status(owner)).toBe(200);
    const active = fileDevices().filter((d) => d.revokedAt === null);
    expect(active.map((d) => d.name)).toEqual(["Owner's phone", "Demo 3", "Demo 4", "Demo 5"]);
    expect(active.filter((d) => d.demo).length).toBe(3);
    // A re-pair revokes its own old device first, so no other one goes.
    vi.setSystemTime(Date.now() + 1000);
    const repaired = await request(app).post("/pair").set("Authorization", `Bearer ${demoTokens[4]}`).send({ code: CODE });
    expect(repaired.status).toBe(200);
    expect(await Promise.all(demoTokens.map(status))).toEqual([401, 401, 200, 200, 401]);
    // Revoked by hand (Settings › Devices): room again, nothing else revoked.
    const ids = fileDevices().filter((d) => d.demo && d.revokedAt === null).map((d) => d.id);
    await host.revoke(ids[0]);
    vi.setSystemTime(Date.now() + 1000);
    await request(app).post("/pair").send({ code: CODE });
    expect(fileDevices().filter((d) => d.demo && d.revokedAt === null)).toHaveLength(3);
    expect(await status(demoTokens[3])).toBe(200);
  });

  it("B-devices-33: a wrong code is 401 as before with the demo code set; without the demo config the demo code is just a wrong code", async () => {
    const on = demoApp(demo());
    for (const code of ["wrong", CODE.slice(0, -1), CODE + "A", CODE.toLowerCase()]) {
      const res = await request(on).post("/pair").send({ code });
      expect(res.status, code).toBe(401);
      expect(res.body).toEqual({ error: "invalid or expired pairing code" });
    }
    const off = demoApp(null);
    const res = await request(off).post("/pair").send({ code: CODE });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid or expired pairing code" });
    // Normal codes still work next to the demo code, single use as ever.
    const normal = await host.createPairingCode(null, "cli");
    expect((await request(on).post("/pair").send({ code: normal.code })).status).toBe(200);
    expect((await request(on).post("/pair").send({ code: normal.code })).status).toBe(401);
    expect(fileDevices().every((d) => d.demo === undefined)).toBe(true);
  });

  it("B-devices-34: behind a proxy (TRUST_PROXY), wrong codes are counted per client IP, the demo code is refused from a blocked IP, and good demo pairings don't count", async () => {
    const app = demoApp(demo(), { trustProxy: "loopback" });
    const from = (ip: string, code: string) => request(app).post("/pair").set("X-Forwarded-For", ip).send({ code });
    for (let i = 0; i < 15; i++) expect((await from("198.51.100.1", CODE)).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await from("203.0.113.5", `wrong-${i}`)).status).toBe(401);
    const blocked = await from("203.0.113.5", CODE);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: "too many wrong pairing codes; try again later" });
    expect((await from("198.51.100.1", CODE)).status).toBe(200);
  });

  it("B-devices-35: the demo code is compared as SHA-256 digests through timingSafeEqual, also when it's expired or another code matched", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const tse = vi.mocked(crypto.timingSafeEqual);
    const expiresAt = Date.now() + DAY;
    const app = demoApp(demo({ expiresAt }));
    const digestCompares = () => tse.mock.calls.filter(([a, b]) => (a as Buffer).length === 32 && (b as Buffer).length === 32).length;

    // No stored codes: the one compare is the demo code's, whatever the length sent.
    const off = demoApp(null);
    tse.mockClear();
    await request(off).post("/pair").send({ code: CODE });
    expect(tse).not.toHaveBeenCalled();
    for (const code of [CODE, "x", CODE + CODE]) {
      tse.mockClear();
      await request(app).post("/pair").send({ code });
      expect(digestCompares(), code).toBe(1);
      expect(tse.mock.calls).toHaveLength(1);
    }
    // A stored code that matches: the demo code is still compared (2, not 1).
    const normal = await host.createPairingCode(null, "cli");
    tse.mockClear();
    expect((await request(app).post("/pair").send({ code: normal.code })).status).toBe(200);
    expect(digestCompares()).toBe(2);
    // Expired: still compared, so the time taken doesn't say it expired.
    vi.setSystemTime(expiresAt + 1);
    tse.mockClear();
    expect((await request(app).post("/pair").send({ code: CODE })).status).toBe(401);
    expect(digestCompares()).toBe(1);
  });

  it("B-devices-39: a demo device gets 403 on device management (list, codes, revoke) and nothing changes; every product route works; a normal device is unchanged", async () => {
    const app = demoApp(demo());
    const pair = async (code: string) => (await request(app).post("/pair").send({ code })).body as { deviceId: string; refreshToken: string };
    const a = await pair(CODE);
    const b = await pair(CODE);
    const owner = await pair((await host.createPairingCode("Owner", "cli")).code);
    const refused = { error: "a demo device can't manage devices" };

    const list = await api(app, a.refreshToken).get("/devices");
    expect(list.status).toBe(403);
    expect(list.body).toEqual(refused);
    const codes = await api(app, a.refreshToken).post("/pairing-codes").send({ name: "x" });
    expect(codes.status).toBe(403);
    expect(codes.body).toEqual(refused);
    for (const id of [b.deviceId, owner.deviceId, a.deviceId]) {
      const del = await request(app).delete(`/devices/${id}`).set("Authorization", `Bearer ${a.refreshToken}`);
      expect(del.status, id).toBe(403);
      expect(del.body).toEqual(refused);
    }
    // Nothing revoked, no code made (the file also gets last-seen writes, so not compared whole).
    expect(fileDevices().filter((d) => d.revokedAt !== null)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(host.file, "utf-8")).pairingCodes).toEqual([]);
    for (const token of [a.refreshToken, b.refreshToken, owner.refreshToken]) expect((await api(app, token).get("/status")).status).toBe(200);

    // Reading, checkbox, home, favourites: as for any device.
    for (const route of ROUTES) {
      const r = route.method === "get" ? api(app, a.refreshToken).get(route.url, route.query) : api(app, a.refreshToken).post(route.url, route.body ?? {});
      expect((await r).status, `${route.method} ${route.url}`).toBeLessThan(400);
    }

    // The normal device still manages, the demo devices too.
    const ownerList = await api(app, owner.refreshToken).get("/devices");
    expect(ownerList.status).toBe(200);
    expect(ownerList.body.devices).toHaveLength(3);
    expect((await api(app, owner.refreshToken).post("/pairing-codes").send({})).status).toBe(200);
    expect((await request(app).delete(`/devices/${b.deviceId}`).set("Authorization", `Bearer ${owner.refreshToken}`)).status).toBe(200);
    expect((await api(app, b.refreshToken).get("/status")).status).toBe(401);
  });

  it("B-devices-36: the demo code never reaches the log, nor the tokens it buys", async () => {
    const logged: string[] = [];
    const capture = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
    for (const m of ["log", "error", "warn", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation(capture);
    const app = demoApp(demo({ maxDevices: 1 }));
    const a = (await request(app).post("/pair").send({ code: CODE })).body.refreshToken;
    const b = (await request(app).post("/pair").send({ code: CODE })).body.refreshToken;
    await request(app).post("/pair").send({ code: CODE + "x" });
    fs.writeFileSync(host.file, "{ broken"); // the malformed-file path logs
    await request(app).post("/pair").send({ code: CODE });
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) for (const secret of [CODE, a, b]) expect(line).not.toContain(secret);
  });
});

// server.ts's startup and the CLI, run as processes.
describe("startup and CLI", () => {
  const run = promisify(execFile);
  const tsNodeBin = path.join(__dirname, "..", "node_modules", ".bin", "ts-node");
  const tsNode = (script: string, args: string[], env: Record<string, string>) =>
    run(tsNodeBin, ["--transpile-only", script, ...args], { cwd: path.join(__dirname, ".."), env: { ...process.env, ...env }, timeout: 30_000 });
  const refusal = (script: string, args: string[], env: Record<string, string>) =>
    tsNode(script, args, env).then(
      () => null,
      (err: { code: number; stdout: string; stderr: string }) => err,
    );
  const baseEnv = () => ({ VAULT_ROOT: v.root, SECRETS_DIR: v.secrets, AUTH_TOKEN: "", PORT: "0", PUBLIC_URL: "https://demo.example", DEMO_MAX_DEVICES: "" });

  /** Starts the server, returns what it printed once it's listening (and a moment after, for the lines that follow). */
  async function startOutput(env: Record<string, string>): Promise<string> {
    const child = spawn(tsNodeBin, ["--transpile-only", "src/server.ts"], { cwd: path.join(__dirname, ".."), env: { ...process.env, ...env } });
    try {
      return await new Promise<string>((resolve, reject) => {
        let text = "";
        const timer = setTimeout(() => reject(new Error(`no start: ${text}`)), 20_000);
        const collect = (d: Buffer) => {
          text += d.toString();
          if (text.includes("auth:")) {
            clearTimeout(timer);
            setTimeout(() => resolve(text), 300);
          }
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        child.on("exit", () => reject(new Error(`exited: ${text}`)));
      });
    } finally {
      child.kill();
    }
  }

  it("B-devices-29: set but invalid → exits 1 with the reason, the code not in it; valid → starts, also without a devices file; only one set → exits 1; neither → as before", async () => {
    for (const [env, message] of [
      [{ DEMO_PAIRING_CODE: "too-short", DEMO_PAIRING_EXPIRES: "2026-12-15" }, /DEMO_PAIRING_CODE must be/],
      [{ DEMO_PAIRING_CODE: CODE, DEMO_PAIRING_EXPIRES: "soon" }, /DEMO_PAIRING_EXPIRES must be/],
      [{ DEMO_PAIRING_CODE: CODE, DEMO_PAIRING_EXPIRES: "2026-12-15", DEMO_MAX_DEVICES: "0" }, /DEMO_MAX_DEVICES must be/],
    ] as const) {
      const refused = await refusal("src/server.ts", [], { ...baseEnv(), ...env });
      expect(refused?.code, JSON.stringify(env)).toBe(1);
      expect(refused?.stderr).toMatch(message);
      expect(refused?.stderr + refused!.stdout).not.toContain(env.DEMO_PAIRING_CODE);
    }

    // Only one of the two: a half-done deploy, so it exits 1, without the code.
    const half = await refusal("src/server.ts", [], { ...baseEnv(), DEMO_PAIRING_CODE: CODE, DEMO_PAIRING_EXPIRES: "" });
    expect(half?.code).toBe(1);
    expect(half?.stderr).toMatch(/together \(only one is set\)/);
    expect(half!.stderr + half!.stdout).not.toContain(CODE);

    const expires = new Date(Date.now() + 30 * DAY).toISOString();
    const out = await startOutput({ ...baseEnv(), DEMO_PAIRING_CODE: CODE, DEMO_PAIRING_EXPIRES: expires, DEMO_MAX_DEVICES: "7" });
    expect(out).toContain(`demo pairing code: on until ${expires}, at most 7 demo devices`);
    expect(out).not.toContain(CODE);

    await host.createPairingCode(null, "cli"); // the devices file, so it starts with the demo code off
    const plain = await startOutput({ ...baseEnv(), DEMO_PAIRING_CODE: "", DEMO_PAIRING_EXPIRES: "" });
    expect(plain).toMatch(/auth: device tokens/);
    expect(plain).not.toMatch(/demo pairing/);
  }, 90_000);

  it("B-devices-37: devices-cli demo-link prints the link the server accepts (no name); unset, invalid or expired → exits 1 without the code", async () => {
    const env = { SECRETS_DIR: v.secrets, PUBLIC_URL: "https://demo.example/", DEMO_PAIRING_CODE: CODE, DEMO_PAIRING_EXPIRES: new Date(Date.now() + DAY).toISOString() };
    const ok = await tsNode("src/devices-cli.ts", ["demo-link"], env);
    const link = ok.stdout.trim();
    expect(link).toBe(`https://mdvju.app/pair#code=${CODE}&backend=https%3A%2F%2Fdemo.example`);
    expect(parsePairLink(link)).toEqual({ code: CODE, backend: "https://demo.example", name: null });
    expect(ok.stderr).toMatch(/expires /);
    expect(fs.existsSync(host.file)).toBe(false); // touches no registry

    const app = demoApp(parseDemoPairing(env));
    expect((await request(app).post("/pair").send({ code: parsePairLink(link)!.code, deviceName: "Demo" })).status).toBe(200);

    for (const [over, message] of [
      [{ DEMO_PAIRING_CODE: "" }, /set DEMO_PAIRING_CODE and DEMO_PAIRING_EXPIRES/],
      [{ DEMO_PAIRING_EXPIRES: "2020-01-01" }, /expired at 2020-01-01T00:00:00.000Z/],
      [{ DEMO_PAIRING_EXPIRES: "whenever" }, /DEMO_PAIRING_EXPIRES must be/],
      [{ PUBLIC_URL: "" }, /set PUBLIC_URL/],
    ] as const) {
      const refused = await refusal("src/devices-cli.ts", ["demo-link"], { ...env, ...over });
      expect(refused?.code, JSON.stringify(over)).toBe(1);
      expect(refused?.stderr).toMatch(message);
      expect(refused!.stdout + refused!.stderr).not.toContain(CODE);
    }
  }, 60_000);
});
