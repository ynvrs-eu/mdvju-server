import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "./atomic-write";

/**
 * The device registry:
 * every install has its own token, set up by pairing, so a device can be
 * revoked or rotated without touching the others and without a restart.
 *
 * Kept in `<secrets dir>/devices.json` (gitignored; mounted into the
 * container as a directory, see docker-compose.yml). The backend and
 * scripts/pair-device.sh / devices.sh (devices-cli.ts, run on the host)
 * both edit it, so the backend re-reads it whenever it changed: one stat
 * per request, compared on inode, size and mtime. That works on any
 * filesystem and on a Docker bind mount, where an inotify watch on the
 * file would miss the atomic rename (a new inode) every writer here does.
 *
 * Only SHA-256 hashes of tokens and pairing codes are stored. A token is
 * 32 random bytes and a code 16, so a plain hash is enough: there's
 * nothing to brute-force. Every write is atomic (writeFileAtomic) and its
 * whole read-change-write runs under a lock file, `devices.json.lock` next
 * to it, which the backend and the CLI both take (without it, the backend's hourly last-seen write could read the file,
 * the CLI revoke a device, and the backend rename its older copy over the
 * revoke). The lock is made with O_EXCL; a writer waits for it, without
 * blocking the event loop, up to LOCK_TIMEOUT_MS, and one older than
 * LOCK_STALE_MS (its writer died) is removed, by one writer only
 * (breakStaleLock, R1). Readers don't take it: every writer replaces the file by
 * renaming, so a read sees the old or the new file, never half of one.
 *
 * `lastSeenAt` is kept in memory per request and written to the file at
 * most once an hour per device, so a busy app doesn't rewrite the file on
 * every request; GET /devices shows the in-memory value.
 *
 * The server secret (`<secrets dir>/server-secret`, 32 random bytes, made
 * on first use) keys each device's attachment key; the CLI never needs it.
 */

export const PAIRING_CODE_TTL_MS = 10 * 60_000;
const LAST_SEEN_WRITE_INTERVAL_MS = 60 * 60_000;
const DEVICE_NAME_MAX = 60;
/** How long a writer waits for the lock before it gives up (an error, nothing written). */
const LOCK_TIMEOUT_MS = 5_000;
/** A lock this old is from a writer that died mid-write: a write takes milliseconds. */
const LOCK_STALE_MS = 15_000;

export interface Device {
  id: string;
  name: string;
  /** Lowercase hex SHA-256 of the device's token. */
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  /**
   * Who made the pairing code this device used: a device id, or "cli"
   * (pair-device.sh, devices.sh rotate, the test backend's hook). Null for
   * devices paired before this was recorded.
   */
  pairedBy: string | null;
  /**
   * Paired with the demo server's reusable code (DemoPairing): only these
   * count toward its device cap and are revoked by it. Missing on every
   * other device.
   */
  demo?: true;
}

/**
 * The demo server's reusable pairing code: App Review opens the link from the review
 * notes days after we submit, so a 10-minute single-use code would be dead.
 * Off unless both DEMO_PAIRING_CODE and DEMO_PAIRING_EXPIRES are set
 * (parseDemoPairing); the production server never sets them.
 */
export interface DemoPairing {
  code: string;
  /** Epoch ms; from then on the code is refused like any unknown one. */
  expiresAt: number;
  /** At most this many active demo devices; a new one revokes the oldest first. */
  maxDevices: number;
}

export const DEMO_MAX_DEVICES_DEFAULT = 20;
const DEMO_CODE_MIN_BYTES = 16;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * The demo pairing settings from the environment, read once at startup.
 * Null (demo pairing off, the server as without this) if either
 * DEMO_PAIRING_CODE or DEMO_PAIRING_EXPIRES is unset or empty. Throws, with
 * a message that never contains the code, if they're set but invalid: the
 * code must be base64url of at least 16 bytes, the expiry an ISO date
 * (`2026-12-15` or `2026-12-15T12:00:00Z`), DEMO_MAX_DEVICES (default 20)
 * a whole number from 1.
 */
export function parseDemoPairing(env: Record<string, string | undefined>): DemoPairing | null {
  const code = (env.DEMO_PAIRING_CODE ?? "").trim();
  const expires = (env.DEMO_PAIRING_EXPIRES ?? "").trim();
  if (code === "" && expires === "") return null;
  // Only one of the two is a half-done deploy: fail loudly rather than run with the demo silently off.
  if (code === "" || expires === "") throw new Error("set DEMO_PAIRING_CODE and DEMO_PAIRING_EXPIRES together (only one is set)");
  if (!/^[A-Za-z0-9_-]+$/.test(code) || Buffer.from(code, "base64url").length < DEMO_CODE_MIN_BYTES) {
    throw new Error(`DEMO_PAIRING_CODE must be base64url of at least ${DEMO_CODE_MIN_BYTES} random bytes (e.g. \`openssl rand 24 | basenc --base64url\`)`);
  }
  const expiresAt = ISO_DATE_RE.test(expires) ? Date.parse(expires) : NaN;
  if (Number.isNaN(expiresAt)) {
    throw new Error("DEMO_PAIRING_EXPIRES must be an ISO date, e.g. 2026-12-15 or 2026-12-15T12:00:00Z");
  }
  const maxRaw = (env.DEMO_MAX_DEVICES ?? "").trim();
  const maxDevices = maxRaw === "" ? DEMO_MAX_DEVICES_DEFAULT : Number(maxRaw);
  if (!/^\d*$/.test(maxRaw) || !Number.isSafeInteger(maxDevices) || maxDevices < 1) {
    throw new Error("DEMO_MAX_DEVICES must be a whole number from 1 (default 20)");
  }
  return { code, expiresAt, maxDevices };
}

export interface PairingCode {
  /** Lowercase hex SHA-256 of the code. */
  codeHash: string;
  /** The name the code was made for, if any (the device may send its own). */
  name: string | null;
  createdAt: string;
  expiresAt: string;
  /** The device id that asked for it, or "cli". */
  createdBy: string;
}

export interface RegistryFile {
  version: 1;
  devices: Device[];
  pairingCodes: PairingCode[];
}

/** A pairing code that is wrong, already used or expired: all look the same to the caller. */
export class InvalidPairingCode extends Error {
  constructor() {
    super("invalid or expired pairing code");
  }
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/**
 * Trimmed, control and format characters (bidi overrides, zero-width) and
 * line/paragraph separators dropped, at most 60 characters. A name is
 * shown in other devices' lists, so it mustn't be able to reorder or hide
 * text there.
 */
export function cleanDeviceName(name: unknown): string {
  if (typeof name !== "string") return "";
  return Array.from(name.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "").trim())
    .slice(0, DEVICE_NAME_MAX)
    .join("")
    .trim();
}

const emptyRegistry = (): RegistryFile => ({ version: 1, devices: [], pairingCodes: [] });

function parseRegistry(text: string): RegistryFile {
  const data = JSON.parse(text) as Partial<RegistryFile>;
  if (data?.version !== 1 || !Array.isArray(data.devices) || !Array.isArray(data.pairingCodes)) {
    throw new Error("unexpected shape");
  }
  return data as RegistryFile;
}

export type DeviceRegistry = ReturnType<typeof openRegistry>;

/** The devices file is locked by another writer for longer than LOCK_TIMEOUT_MS. */
export class RegistryBusy extends Error {
  constructor(file: string) {
    super(`${file} is being written by another process; try again`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface RegistryOptions {
  /** Called once per write that has to wait for another writer's lock (the CLI says so). */
  onLockWait?: () => void;
  lockTimeoutMs?: number;
  /** Tests only: runs after a lock was found stale, before it is broken (forces the R1 race). */
  beforeStaleBreak?: () => void;
}

export function openRegistry(secretsDir: string, now: () => number = () => Date.now(), options: RegistryOptions = {}) {
  const file = path.join(secretsDir, "devices.json");
  const lockFile = `${file}.lock`;
  const secretFile = path.join(secretsDir, "server-secret");
  let cache: { version: string; data: RegistryFile | null } = { version: "", data: null };
  let serverSecret: string | null = null;
  const lastSeen = new Map<string, number>();
  /** Devices whose last-seen write is under way: requests meanwhile don't start another. */
  const touching = new Set<string>();
  /** What this writer put in the lock file while it holds the lock, else null. */
  let heldToken: string | null = null;

  /** Whether the lock file is still the one this writer made: not broken as stale and taken by another. */
  function holdsLock(): boolean {
    try {
      return heldToken !== null && fs.readFileSync(lockFile, "utf-8") === heldToken;
    } catch {
      return false;
    }
  }

  /**
   * The file as it is now: re-read only when its inode, size or mtime
   * changed. Missing = an empty registry. Unreadable or malformed = null:
   * no device is let in and nothing is written over it (fail closed).
   */
  function current(): RegistryFile | null {
    let version = "missing";
    try {
      const st = fs.statSync(file);
      version = `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") version = "error";
    }
    if (version !== cache.version || version === "error") {
      let data: RegistryFile | null = null;
      try {
        data = version === "missing" ? emptyRegistry() : parseRegistry(fs.readFileSync(file, "utf-8"));
      } catch {
        // Never the file's content in the log: it's only hashes, but still.
        if (cache.data !== null || cache.version === "") console.error(`devices file ${file} is unreadable or malformed; no device can sign in`);
      }
      cache = { version, data };
    }
    return cache.data;
  }

  /**
   * Breaks a lock found stale (its writer died), if it's still that lock.
   * Two writers can find the same lock stale at once; the
   * first breaks it and takes a new lock, and the second must not remove
   * that one. So the lock is moved aside under a name of this writer's
   * own (rename is atomic: only one writer gets it), and removed only if
   * it is the lock that was judged stale: the same inode and still stale
   * (a freed inode number is often reused at once, so the inode alone
   * isn't enough). A newer lock moved aside by mistake is linked back
   * (link never replaces a file). If that fails because a third writer took the lock meanwhile, the
   * first holder has lost it: it finds out before it writes (holdsLock in
   * updateLocked) and writes nothing.
   */
  function breakStaleLock(staleIno: number): void {
    const aside = `${lockFile}.${process.pid}.${randomBytes(4).toString("hex")}`;
    try {
      fs.renameSync(lockFile, aside);
    } catch {
      return; // already broken or released by someone else
    }
    try {
      const moved = fs.statSync(aside);
      if (moved.ino === staleIno && Date.now() - moved.mtimeMs > LOCK_STALE_MS) {
        console.error(`removed a stale lock ${lockFile}`);
      } else {
        fs.linkSync(aside, lockFile);
      }
    } catch {
      // A new lock is in place already (EEXIST): leave it.
    } finally {
      fs.rmSync(aside, { force: true });
    }
  }

  /**
   * Runs `fn` holding the lock file. Throws RegistryBusy if another
   * writer holds it too long. The wait is async (it used to
   * block the event loop, so every request, for up to 5 s); taking the
   * lock, `fn` and the release run without a break, so two writes in one
   * process never interleave either.
   */
  async function withLock<T>(fn: () => T): Promise<T> {
    const deadline = Date.now() + (options.lockTimeoutMs ?? LOCK_TIMEOUT_MS);
    let waited = false;
    fs.mkdirSync(secretsDir, { recursive: true });
    const token = `${process.pid}:${randomBytes(8).toString("hex")}`;
    for (;;) {
      try {
        const fd = fs.openSync(lockFile, "wx", 0o600);
        try {
          fs.writeSync(fd, token);
        } finally {
          fs.closeSync(fd);
        }
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      let lock: fs.Stats;
      try {
        lock = fs.statSync(lockFile);
      } catch {
        continue; // released between the open and the stat
      }
      if (Date.now() - lock.mtimeMs > LOCK_STALE_MS) {
        options.beforeStaleBreak?.();
        breakStaleLock(lock.ino);
        continue;
      }
      if (Date.now() >= deadline) throw new RegistryBusy(file);
      if (!waited) {
        waited = true;
        options.onLockWait?.();
      }
      await sleep(10);
    }
    heldToken = token;
    try {
      return fn();
    } finally {
      // Only our own lock: one broken as stale may be another writer's now (RL1).
      if (holdsLock()) fs.rmSync(lockFile, { force: true });
      heldToken = null;
    }
  }

  /**
   * Read, change, write atomically, all under the lock, so no other
   * writer's change made in between is written over. `change` may throw
   * to cancel; nothing is written then.
   */
  function update<T>(change: (data: RegistryFile) => T): Promise<T> {
    return withLock(() => updateLocked(change));
  }

  function updateLocked<T>(change: (data: RegistryFile) => T): T {
    const loaded = current();
    if (loaded === null) throw new Error("devices file is unreadable or malformed; fix or remove it first");
    const data = structuredClone(loaded);
    const result = change(data);
    const t = now();
    data.pairingCodes = data.pairingCodes.filter((c) => Date.parse(c.expiresAt) > t);
    const isNew = !fs.existsSync(file);
    fs.mkdirSync(secretsDir, { recursive: true });
    // Lost the lock (broken as stale, taken by another writer): write
    // nothing, or this copy could undo the other writer's change (RL1).
    if (!holdsLock()) throw new RegistryBusy(file);
    writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n");
    // Owner only: every writer runs as the container's user (the scripts
    // via `docker compose run`). writeFileAtomic keeps the mode
    // of an existing file.
    if (isNew) fs.chmodSync(file, 0o600);
    current();
    return result;
  }

  function activeDevices(): Device[] {
    return (current()?.devices ?? []).filter((d) => d.revokedAt === null);
  }

  function secret(): string {
    if (serverSecret !== null) return serverSecret;
    try {
      serverSecret = fs.readFileSync(secretFile, "utf-8").trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      fs.mkdirSync(secretsDir, { recursive: true });
      try {
        // `wx`: if another process made it first, use theirs.
        fs.writeFileSync(secretFile, randomBytes(32).toString("hex") + "\n", { flag: "wx", mode: 0o600 });
      } catch (writeErr) {
        if ((writeErr as NodeJS.ErrnoException).code !== "EEXIST") throw writeErr;
      }
      serverSecret = fs.readFileSync(secretFile, "utf-8").trim();
    }
    if (serverSecret.length < 32) throw new Error(`${secretFile} is too short`);
    return serverSecret;
  }

  const attachmentKeyFor = (deviceId: string): string =>
    createHmac("sha256", secret()).update(`attachment-v1:${deviceId}`).digest("hex");

  return {
    file,

    /** Whether the devices file exists (the backend may then run without AUTH_TOKEN). */
    exists: () => fs.existsSync(file),

    /** The non-revoked device this token belongs to, or null. */
    findByToken(token: string): Device | null {
      if (token === "") return null;
      const hash = sha256Hex(token);
      return activeDevices().find((d) => sameHex(d.tokenHash, hash)) ?? null;
    },

    /** The non-revoked device whose attachment key this is, or null. */
    findByAttachmentKey(key: string): Device | null {
      if (!/^[0-9a-f]{64}$/.test(key)) return null;
      return activeDevices().find((d) => sameHex(attachmentKeyFor(d.id), key)) ?? null;
    },

    /** The device's read-only attachment key: hex HMAC-SHA256(server secret, "attachment-v1:" + id). */
    attachmentKeyFor,

    /** Reads the server secret, making it first if it's missing (called at startup, so a bad mount fails early). */
    ensureServerSecret: (): void => void secret(),

    /**
     * Notes that the device made a request; written to the file at most
     * hourly, in the background: the request never waits for it. Resolves
     * when that write is done (tests wait for it).
     */
    touch(device: Device): Promise<void> {
      const t = now();
      lastSeen.set(device.id, t);
      const stored = device.lastSeenAt === null ? 0 : Date.parse(device.lastSeenAt);
      if (t - stored < LAST_SEEN_WRITE_INTERVAL_MS || touching.has(device.id)) return Promise.resolve();
      touching.add(device.id);
      return update((data) => {
        const d = data.devices.find((x) => x.id === device.id);
        if (d) d.lastSeenAt = new Date(t).toISOString();
      })
        .catch((err: unknown) => {
          // Last-seen is informational: never fail the request over it.
          console.error(`couldn't record last-seen: ${(err as Error).message}`);
        })
        .finally(() => touching.delete(device.id));
    },

    /** Every device, revoked ones included, with the in-memory last-seen time. */
    list(): Device[] {
      return (current()?.devices ?? []).map((stored) => {
        const d = { ...stored, pairedBy: stored.pairedBy ?? null };
        const mem = lastSeen.get(d.id);
        const fromFile = d.lastSeenAt === null ? 0 : Date.parse(d.lastSeenAt);
        return mem !== undefined && mem > fromFile ? { ...d, lastSeenAt: new Date(mem).toISOString() } : d;
      });
    },

    /**
     * A new single-use pairing code, valid for 10 minutes. Only its hash is
     * stored. A device has one open code at a time: its earlier unused ones
     * are dropped (the app makes one each time the devices view
     * opens). The server's own codes ("cli") are left alone, so two can be
     * handed out at once.
     */
    async createPairingCode(name: string | null, createdBy: string): Promise<{ code: string; expiresAt: string }> {
      const code = randomBytes(16).toString("base64url");
      const t = now();
      const expiresAt = new Date(t + PAIRING_CODE_TTL_MS).toISOString();
      await update((data) => {
        if (createdBy !== "cli") data.pairingCodes = data.pairingCodes.filter((c) => c.createdBy !== createdBy);
        data.pairingCodes.push({
          codeHash: sha256Hex(code),
          name: cleanDeviceName(name) || null,
          createdAt: new Date(t).toISOString(),
          expiresAt,
          createdBy,
        });
      });
      return { code, expiresAt };
    },

    /**
     * Trades a pairing code for a new device and its token. The code is
     * used up. Throws InvalidPairingCode for a wrong, used or expired code.
     * The name is the device's own, else the code's, else "Unnamed device".
     *
     * `previousToken` is the token the install held for this backend
     * before (a re-pair): if it's an active device's, that
     * device is revoked in the same write, so the old token can't outlive
     * the pairing that replaced it. Anything else in it (wrong, revoked,
     * the shared token) is ignored. A wrong code revokes nothing.
     *
     * `demo` (the demo server only): its code is accepted any
     * number of times until its expiry, compared in constant time like the
     * others (both sides hashed, so equal length). Each use is a new device,
     * marked `demo`, named "Demo <n>" unless the device sends a name. With
     * `maxDevices` active demo devices already, the oldest are revoked
     * first; no other device is ever counted or revoked by it. After the
     * expiry it's InvalidPairingCode, the same as any unknown code.
     */
    pair(code: string, deviceName: unknown, previousToken = "", demo: DemoPairing | null = null): Promise<{ device: Device; token: string }> {
      const hash = sha256Hex(code);
      const previousHash = previousToken === "" ? null : sha256Hex(previousToken);
      return update((data) => {
        const t = now();
        const index = data.pairingCodes.findIndex((c) => sameHex(c.codeHash, hash) && Date.parse(c.expiresAt) > t);
        // Compared even when expired or a stored code matched, so the
        // timing doesn't tell whether a demo code exists or has expired.
        const demoMatch = demo !== null && sameHex(sha256Hex(demo.code), hash);
        const isDemo = index === -1 && demoMatch && t < demo.expiresAt;
        if (index === -1 && !isDemo) throw new InvalidPairingCode();
        const used = isDemo ? null : data.pairingCodes.splice(index, 1)[0];
        const stamp = new Date(t).toISOString();
        const replaced = previousHash === null ? undefined : data.devices.find((d) => d.revokedAt === null && sameHex(d.tokenHash, previousHash));
        if (replaced) replaced.revokedAt = stamp;
        if (isDemo) {
          // Oldest first (createdAt, then file order), until there's room for one more.
          const active = data.devices.filter((d) => d.demo === true && d.revokedAt === null).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
          for (const old of active.slice(0, Math.max(0, active.length - demo.maxDevices + 1))) old.revokedAt = stamp;
        }
        const token = randomBytes(32).toString("base64url");
        let id: string;
        do id = randomBytes(6).toString("hex");
        while (data.devices.some((d) => d.id === id));
        const demoNumber = data.devices.filter((d) => d.demo === true).length + 1;
        const device: Device = {
          id,
          name: cleanDeviceName(deviceName) || (used ? used.name || "Unnamed device" : `Demo ${demoNumber}`),
          tokenHash: sha256Hex(token),
          createdAt: stamp,
          lastSeenAt: null,
          revokedAt: null,
          // The server's own code: the app shows "Paired on the server".
          pairedBy: used ? used.createdBy : "cli",
          ...(isDemo ? { demo: true as const } : {}),
        };
        data.devices.push(device);
        return { device, token };
      });
    },

    /** Revokes a device: its token and attachment key stop working at once. Null if there's no such active device. */
    revoke(id: string): Promise<Device | null> {
      return update((data) => {
        const d = data.devices.find((x) => x.id === id && x.revokedAt === null);
        if (!d) return null;
        d.revokedAt = new Date(now()).toISOString();
        return d;
      });
    },
  };
}
