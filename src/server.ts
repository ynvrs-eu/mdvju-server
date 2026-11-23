import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import { createHash, createHmac, timingSafeEqual } from "crypto";
import * as fs from "fs";
import type { AddressInfo } from "net";
import * as path from "path";
import { pipeline } from "stream";
import { sweepStaleTempFiles } from "./atomic-write";
import { migrateViewerStateDir } from "./viewer-state";
import { cleanDeviceName, InvalidPairingCode, openRegistry, parseDemoPairing, type DemoPairing, type Device } from "./devices";
import { createVaultIndex, type IndexSnapshot, type VaultIndex } from "./vault-index";
import { createAttachmentInfo } from "./attachment-info";
import {
  API_VERSION,
  DEMO_DEVICE_REFUSAL,
  type AttachmentKey,
  type CheckboxRequest,
  type CheckboxResponse,
  type DeviceList,
  type ErrorResponse,
  type OkResponse,
  type PairingCodeResponse,
  type PairRequest,
  type PairResponse,
  type ResolveEmbedResponse,
  type ResolveResponse,
  type SearchResponse,
  type StatusResponse,
} from "../shared/api-types";
import { buildPairLink } from "../shared/pair-link";
import { toggleCheckboxInContent, type CheckboxRefusal } from "../shared/checkbox-edit";
import {
  allPaths,
  parseRecentCursor,
  RECENT_FILES_LIMIT,
  recentPage,
  searchNotes,
  type RecentCursor,
} from "../shared/vault-queries";
import { openVault, VaultError, VaultErrorKind } from "./vault";
import {
  embedPathMatched,
  markdownEmbedPathMatched,
  resolveEmbed,
  resolveFreshIfUnsure,
  resolveMarkdownEmbed,
  resolveWikilink,
  wikilinkPathMatched,
} from "../shared/wikilink";

// Constant-time token check: comparing SHA-256 digests
// keeps both sides the same length, so neither the comparison's timing nor
// a length mismatch says anything about the real token.
function tokenMatches(given: string | undefined, expected: string): boolean {
  if (typeof given !== "string" || expected === "") return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * The read-only key that `GET /attachment` takes in its URL:
 * hex HMAC-SHA256 of the label "attachment-v1", keyed with AUTH_TOKEN. An
 * image URL can't carry a header, so something has to travel in the URL;
 * this key opens attachments and nothing else, so a copy in the iOS URL
 * cache or a proxy log can't write. Derived, so there's nothing new to
 * configure, and rotating AUTH_TOKEN rotates it. No token, no key.
 * This is the shared token's key; a paired device has its own
 * (devices.ts attachmentKeyFor).
 */
export function deriveAttachmentKey(authToken: string): string {
  if (authToken === "") return "";
  return createHmac("sha256", authToken).update("attachment-v1").digest("hex");
}

export interface AppConfig {
  vaultRoot: string;
  /**
   * The shared token. While it's set, it's accepted as a
   * Bearer token next to the device tokens, and its attachment key as
   * `?key=` on /attachment. Unset or "": device tokens only. Removing AUTH_TOKEN
   * from the environment is the whole switch.
   */
  authToken?: string;
  /** Holds devices.json and server-secret (devices.ts). */
  secretsDir: string;
  /**
   * The backend's own URL, put into pairing links (PUBLIC_URL, required by
   * the server's startup). Without it (tests, the fixture backend) the URL
   * the request came in on.
   */
  publicUrl?: string;
  /** Express "trust proxy" (TRUST_PROXY), so the /pair rate limit sees the client's IP behind a reverse proxy, not the proxy's. */
  trustProxy?: string;
  /**
   * The one browser origin allowed to call the API (CORS_ORIGIN), e.g. the
   * Expo web dev server. Unset: no CORS headers at all; the iOS app isn't a
   * browser and doesn't need them.
   */
  corsOrigin?: string;
  /**
   * The demo server's reusable pairing code (DEMO_PAIRING_CODE and
   * DEMO_PAIRING_EXPIRES); null or unset everywhere else.
   */
  demoPairing?: DemoPairing | null;
  /** Age at which a vault index snapshot gets rebuilt in the background (vault-index.ts); 0 = walk on every call, for tests that edit the vault. */
  indexTtlMs?: number;
}

/** Who a request is from: a paired device, or (during the transition) the shared token. */
type Principal = { kind: "device"; device: Device } | { kind: "shared" };

const PAIR_FAILURES_MAX = 10;
/** How long a stopping server waits for responses in flight (docker stop waits 10 s). */
const SHUTDOWN_GRACE_MS = 5_000;
const PAIR_FAILURE_WINDOW_MS = 60 * 60_000;

/**
 * Wrong pairing codes per client IP (10 an hour, then
 * 429). In memory: a restart forgets it, which is fine at 128 bits a code.
 */
function createPairLimiter() {
  const failures = new Map<string, number[]>();
  const recent = (ip: string): number[] => {
    const now = Date.now();
    const list = (failures.get(ip) ?? []).filter((at) => now - at < PAIR_FAILURE_WINDOW_MS);
    if (list.length > 0) failures.set(ip, list);
    else failures.delete(ip);
    return list;
  };
  return {
    /** Seconds until this IP may try again; 0 if it may now. */
    retryAfter(ip: string): number {
      const list = recent(ip);
      if (list.length < PAIR_FAILURES_MAX) return 0;
      return Math.max(1, Math.ceil((list[list.length - PAIR_FAILURES_MAX] + PAIR_FAILURE_WINDOW_MS - Date.now()) / 1000));
    },
    fail(ip: string): void {
      failures.set(ip, [...recent(ip), Date.now()]);
    },
  };
}


/** A malformed request: missing or invalid query params or body fields. */
class BadRequest extends Error {}

/** Authenticated, but not as a paired device (the shared token on a device route). */
class Forbidden extends Error {}

class NotFound extends Error {}

const STATUS_FOR: Record<VaultErrorKind, number> = {
  "invalid-path": 400,
  "not-found": 404,
  conflict: 409,
  "too-large": 413,
  io: 500,
};

// POST /file/checkbox's 409 messages, one per refusal of the shared edit.
const CHECKBOX_CONFLICT: Record<CheckboxRefusal, string> = {
  "not-a-task": "line is not a checkbox -- file may have changed",
  "in-fence": "line is inside a code block",
  "line-changed": "line has changed since the note was loaded",
};

/** An async route for Express 4, which doesn't pass a rejected promise to the error middleware itself. */
function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

/** A request body as it arrives: each field may be missing or of any type until checked. */
type Unvalidated<T> = { [K in keyof T]?: unknown };

/** A required, non-empty string param, or a 400. */
function requiredString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) throw new BadRequest(`missing required ${what}`);
  return value;
}

/**
 * A lookup on the cached snapshot, tried again on a fresh index
 * (VaultIndex.fresh) when it misses or misses the path the link names
 * (resolveFreshIfUnsure). A rebuild that fails keeps the first answer (a
 * miss answers null, not a 500). The wait is one walk at most once per
 * TTL: 116-199 ms warm and 483-763 ms cold over a vault of 15,181 files
 * and 4,155 notes on an NFS mount, so it isn't raced against a timer.
 */
function lookUp(index: VaultIndex, find: (snapshot: IndexSnapshot) => string | null, matched: (path: string) => boolean): Promise<string | null> {
  return resolveFreshIfUnsure(find, matched, () => index.get(), () => index.fresh().catch(() => null));
}

export function createApp(config: AppConfig) {
  const app = express();
  const vault = openVault(config.vaultRoot);
  const index = createVaultIndex(config.vaultRoot, config.indexTtlMs);
  const attachments = createAttachmentInfo(vault);
  const sharedToken = config.authToken ?? "";
  const sharedAttachmentKey = deriveAttachmentKey(sharedToken);
  const devices = openRegistry(config.secretsDir);
  devices.ensureServerSecret();
  const pairLimiter = createPairLimiter();
  if (config.trustProxy) app.set("trust proxy", config.trustProxy);

  const principal = (res: Response): Principal => res.locals.principal as Principal;
  /**
   * The device a request is from, for the device-management routes
   * (GET /devices, POST /pairing-codes, DELETE /devices/:id). Forbidden for
   * the shared token, and for a demo device: on the public
   * demo one visitor mustn't sign out another, the App Reviewer included,
   * or hand out codes.
   */
  const requireDevice = (res: Response): Device => {
    const p = principal(res);
    if (p.kind !== "device") throw new Forbidden("only a paired device can do this");
    if (p.device.demo === true) throw new Forbidden(DEMO_DEVICE_REFUSAL);
    return p.device;
  };

  // CORS only for an origin named in CORS_ORIGIN (Expo web in local dev):
  // `*` let any web page call the API with a token it had.
  if (config.corsOrigin) app.use(cors({ origin: config.corsOrigin }));

  // No response is ever stored by a client's HTTP cache:
  // iOS's URL cache kept /pair (the refresh token), /attachment-key and
  // vault content in the app's Cache.db after a sign-out. Every route, errors and 401s too, and /attachment: the app
  // keeps images in its own cache, not the HTTP one. Set first, so it's on
  // every response; no route sets its own Cache-Control.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  // Auth runs before the body is parsed, so an unauthenticated request
  // never reaches the JSON parser. Two routes take no
  // credential: POST /pair (the pairing code in its body is one) and
  // GET /health (the container's healthcheck, which has no token).
  app.use((req: Request, res: Response, next: NextFunction) => {
    if ((req.method === "POST" && req.path === "/pair") || (req.method === "GET" && req.path === "/health")) {
      next();
      return;
    }
    const authHeader = req.header("authorization") ?? "";
    const [scheme, headerToken] = authHeader.split(" ");
    // /attachment is loaded by RN's native Image component (via a plain
    // <img src> URL from the markdown renderer), which can't attach a
    // custom Authorization header, so GET /attachment is the one route
    // that takes a credential in the URL: `?key=`, the read-only
    // attachment key. Everywhere else a credential in the
    // URL (which ends up in logs and caches) is refused, and the key is refused everywhere but here. A token is never
    // taken from the URL, here neither: `?token=` on /attachment, kept for
    // apps installed before 2026-10-13, was removed on 2026-11-13.
    const attachmentRoute = req.method === "GET" && req.path === "/attachment";
    const queryKey = req.query.key;
    let who: Principal | null = null;
    if (scheme === "Bearer" && typeof headerToken === "string") {
      const device = devices.findByToken(headerToken);
      if (device) who = { kind: "device", device };
      else if (tokenMatches(headerToken, sharedToken)) who = { kind: "shared" };
    }
    if (who === null && attachmentRoute && typeof queryKey === "string") {
      const device = devices.findByAttachmentKey(queryKey);
      if (device) who = { kind: "device", device };
      else if (tokenMatches(queryKey, sharedAttachmentKey)) who = { kind: "shared" };
    }
    if (who === null) {
      res.status(401).json({ error: "unauthorized" } satisfies ErrorResponse);
      return;
    }
    // In the background: the request doesn't wait for a last-seen write.
    if (who.kind === "device") void devices.touch(who.device);
    res.locals.principal = who;
    next();
  });
  app.use(express.json());

  // The healthcheck (Dockerfile HEALTHCHECK): the server
  // answers, and the vault has entries. An empty or unreadable vault is
  // a stale bind mount (docker-compose.yml): 503, so the
  // watchdog restarts the container. Says nothing else about the vault.
  app.get("/health", asyncRoute(async (_req: Request, res: Response) => {
    let entries = 0;
    try {
      entries = (await fs.promises.readdir(config.vaultRoot)).length;
    } catch {
      // Gone or unreadable: unhealthy.
    }
    if (entries > 0) res.status(200).json({ ok: true } satisfies OkResponse);
    else res.status(503).json({ error: "vault is empty or unreadable" } satisfies ErrorResponse);
  }));

  app.get("/status", (_req: Request, res: Response) => {
    res.status(200).json({ apiVersion: API_VERSION } satisfies StatusResponse);
  });

  // The attachment key for image URLs: the requesting
  // device's own, or the shared token's while that's still
  // in use. Behind the Bearer header like every other route; the key
  // itself can't fetch it.
  app.get("/attachment-key", (_req: Request, res: Response) => {
    const p = principal(res);
    const body: AttachmentKey = { key: p.kind === "device" ? devices.attachmentKeyFor(p.device.id) : sharedAttachmentKey };
    res.status(200).json(body);
  });

  // Pairing: a single-use code from POST /pairing-codes
  // or scripts/pair-device.sh buys a new device and its own token. Wrong
  // codes count against the client's IP; from the 11th within an hour on
  // it's 429, whatever the code. A Bearer header on it is the device's
  // previous token, revoked by a successful re-pair. `refreshToken` is named for the later
  // short-lived access tokens; until then it is the Bearer
  // token itself. On the demo server its reusable code works here too;
  // once expired it's a wrong code like any other.
  app.post("/pair", asyncRoute(async (req: Request, res: Response) => {
    const ip = req.ip ?? "";
    const wait = pairLimiter.retryAfter(ip);
    if (wait > 0) {
      res.status(429).setHeader("Retry-After", String(wait));
      res.json({ error: "too many wrong pairing codes; try again later" } satisfies ErrorResponse);
      return;
    }
    const body: Unvalidated<PairRequest> = req.body ?? {};
    const code = requiredString(body.code, "field: code");
    // A re-pair: the app sends the token it holds for this
    // backend as a Bearer header, and pair() revokes that device once the
    // code is good. Optional, and never checked here: a wrong or revoked
    // token pairs as if it weren't there.
    const [scheme, previousToken] = (req.header("authorization") ?? "").split(" ");
    let paired;
    try {
      paired = await devices.pair(code, body.deviceName, scheme === "Bearer" && typeof previousToken === "string" ? previousToken : "", config.demoPairing ?? null);
    } catch (err) {
      if (!(err instanceof InvalidPairingCode)) throw err;
      pairLimiter.fail(ip);
      res.status(401).json({ error: err.message } satisfies ErrorResponse);
      return;
    }
    res.status(200).json({ deviceId: paired.device.id, name: paired.device.name, refreshToken: paired.token } satisfies PairResponse);
  }));

  // Every paired device may add devices. The shared
  // token may not: it isn't a device that could be revoked afterwards.
  app.post("/pairing-codes", asyncRoute(async (req: Request, res: Response) => {
    const device = requireDevice(res);
    const name = cleanDeviceName(req.body?.name) || null;
    const { code, expiresAt } = await devices.createPairingCode(name, device.id);
    const backend = (config.publicUrl || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
    const body: PairingCodeResponse = { code, expiresAt, link: buildPairLink({ code, backend, name }) };
    res.status(200).json(body);
  }));

  // Settings -> Devices in the app: the active devices, never a hash,
  // each with who paired it: a device's name (also a revoked
  // one's), "cli" for the server's scripts, null if not recorded.
  app.get("/devices", (_req: Request, res: Response) => {
    const me = requireDevice(res);
    const all = devices.list();
    const body: DeviceList = {
      devices: all
        .filter((d) => d.revokedAt === null)
        .map((d) => ({
          id: d.id,
          name: d.name,
          createdAt: d.createdAt,
          lastSeenAt: d.lastSeenAt,
          current: d.id === me.id,
          pairedBy: d.pairedBy,
          pairedByName: d.pairedBy === null || d.pairedBy === "cli" ? null : (all.find((x) => x.id === d.pairedBy)?.name ?? null),
        })),
    };
    res.status(200).json(body);
  });

  // Takes effect on the next request, the requester's own device included
  // (the app then signs itself out).
  app.delete("/devices/:id", asyncRoute(async (req: Request, res: Response) => {
    requireDevice(res);
    if ((await devices.revoke(req.params.id)) === null) throw new NotFound("no such device");
    res.status(200).json({ ok: true } satisfies OkResponse);
  }));

  app.get("/file", (req: Request, res: Response) => {
    const content = vault.readNote(requiredString(req.query.path, "query param: path"));
    res.status(200).type("text/plain").send(content);
  });

  // A note's raw bytes at any size, for the app's "Open in another app" on
  // a note /file refuses as too large. Streamed, never read into memory;
  // the Bearer header only (the attachment key opens /attachment alone).
  // No ETag and no Range: it's a one-off download.
  app.get("/file/download", asyncRoute(async (req: Request, res: Response) => {
    const note = await vault.openNote(requiredString(req.query.path, "query param: path"));
    const stream = await note.open();
    if (res.destroyed) {
      stream.destroy();
      return;
    }
    res.status(200).setHeader("Content-Length", note.size);
    res.setHeader("Content-Type", note.mimeType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    pipeline(stream, res, () => {});
  }));

  // Toggles a single task-list checkbox in place -- the one deliberate
  // exception to this app's otherwise read-only stance (a
  // checkbox you can tap but not save is no use). `line`
  // is 1-indexed against the same raw content the client already has
  // from /file, so a stale line (the file changed since it was fetched)
  // is rejected with 409 rather than silently corrupting a different
  // line -- the client's job to reload and let the user retry.
  // `expectedLine` is the raw line as the client loaded it;
  // any difference is also a 409, which catches a line inserted above the
  // target (still a checkbox, but a different task). Required since
  // 2026-10-07, once every installed app sent it.
  app.post("/file/checkbox", (req: Request, res: Response) => {
    const { path: relativePath, line, checked, expectedLine, baseEtag }: Unvalidated<CheckboxRequest> = req.body ?? {};
    const notePath = requiredString(relativePath, "field: path");
    if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
      throw new BadRequest("missing or invalid field: line");
    }
    if (typeof checked !== "boolean") throw new BadRequest("missing or invalid field: checked");
    if (typeof expectedLine !== "string") throw new BadRequest("missing or invalid field: expectedLine");
    if (baseEtag !== undefined && typeof baseEtag !== "string") throw new BadRequest("invalid field: baseEtag");

    const etagOf = (content: string): string => req.app.get("etag fn")(content, "utf-8");
    let baseMatched = false;
    const updated = vault.updateNote(notePath, (content) => {
      // Whether the write went onto exactly the version the client has. If
      // not, the new ETag also covers someone else's edit, and the client
      // must fetch rather than adopt it.
      baseMatched = baseEtag !== undefined && etagOf(content) === baseEtag;
      // shared/checkbox-edit.ts: only the task's state character changes;
      // not a task, inside a code block, or a changed line is a conflict.
      const edit = toggleCheckboxInContent(content, line, checked, expectedLine);
      if (!edit.ok) throw new VaultError("conflict", CHECKBOX_CONFLICT[edit.reason]);
      return edit.content;
    });
    // Same generator Express uses for GET /file's ETag.
    res.status(200).json({ ok: true, etag: etagOf(updated), baseMatched } satisfies CheckboxResponse);
  });

  // Home page + favourites, stored server-side so every install sees the
  // same set -- the second deliberate write-path after
  // /file/checkbox, but to the app's own hidden state file, never a note.
  // A corrupt state.json reads as empty defaults here, but the two write
  // paths below refuse with 500 rather than overwrite it.
  app.get("/state", (_req: Request, res: Response) => {
    res.status(200).json(vault.readState());
  });

  app.post("/home", (req: Request, res: Response) => {
    res.status(200).json(vault.setHome(requiredString(req.body?.path, "field: path")));
  });

  app.post("/favourites/toggle", (req: Request, res: Response) => {
    res.status(200).json(vault.toggleFavourite(requiredString(req.body?.path, "field: path")));
  });

  // Filename/path quick-switcher search, not full-text content search
  // (that's a later, undesigned stage).
  app.get("/search", asyncRoute(async (req: Request, res: Response) => {
    const q = req.query.q;
    if (typeof q !== "string") {
      res.status(200).json({ results: [] } satisfies SearchResponse);
      return;
    }
    res.status(200).json({ results: searchNotes(await index.get(), q) } satisfies SearchResponse);
  }));

  // One directory level for the file opener's folder browser -- loaded
  // lazily as the user drills down, not one big nested tree. `path`
  // omitted (or empty) means the vault root. Dot-folders are hidden from
  // listings, and refused here too so they can't be browsed by name.
  app.get("/tree", (req: Request, res: Response) => {
    const dirParam = req.query.path;
    res.status(200).json(vault.listDir(typeof dirParam === "string" ? dirParam : ""));
  });

  // Every folder and note in the vault, for the file opener's browse-mode
  // search: the app fetches this once and filters names
  // locally as you type. Same entries /tree lists, just all levels at once:
  // .md notes only, dot-entries and links out of the vault left out.
  app.get("/paths", asyncRoute(async (_req: Request, res: Response) => {
    res.status(200).json(allPaths(await index.get()));
  }));

  // Most-recently-modified files, for the file opener's default (empty
  // query) view -- "what's been touched lately" is the common case for
  // opening the switcher at all, per the ask. Files with nothing to show
  // (empty, or frontmatter-only) are skipped; the index knows which those
  // are (it reads every note anyway), so /recent reads none.
  //
  // Paginated: `cursor`, when given, is the `mtimeMs` of
  // the last item the client already has -- only strictly-older files
  // are considered, same page size as before. Returns `nextCursor` (the
  // last item's own mtimeMs) when a further page might exist, or `null`
  // once the candidate list itself is exhausted. `mtimeMs` is now
  // included per result (the app groups results by day).
  app.get("/recent", asyncRoute(async (req: Request, res: Response) => {
    // The cursor's format is in shared/vault-queries.ts (parseRecentCursor).
    const cursorParam = req.query.cursor;
    let cursor: RecentCursor | null = null;
    if (typeof cursorParam === "string") {
      try {
        cursor = parseRecentCursor(cursorParam);
      } catch {
        throw new BadRequest("invalid cursor");
      }
    }
    const { notes, displayable } = await index.get();
    const page = await recentPage(notes, cursor, RECENT_FILES_LIMIT, (p) => displayable.has(p));
    res.status(200).json(page);
  }));

  app.get(
    "/resolve",
    asyncRoute(async (req: Request, res: Response) => {
      const link = requiredString(req.query.link, "query param: link");
      // A miss, or a path link answered by another note of the same name, is
      // checked again on a fresh index (lookUp): the note may be new.
      const resolved = await lookUp(index, (s) => resolveWikilink(link, s), (p) => wikilinkPathMatched(link, p));
      res.status(200).json({ path: resolved } satisfies ResolveResponse);
    }),
  );

  // Resolves an Obsidian `![[attachment]]` embed target to a vault-relative
  // path -- separate from /resolve since embeds can point at any file
  // (images, GIFs), not just notes. A file /attachment serves also gets its
  // size and mtime, and an image its size in pixels, so the
  // app can size and cache it before downloading it.
  app.get(
    "/resolve-embed",
    asyncRoute(async (req: Request, res: Response) => {
      const link = requiredString(req.query.link, "query param: link");
      // With `from` (the note's path), `link` is a Markdown image's target,
      // resolved relative to that note.
      const from = req.query.from === undefined ? undefined : requiredString(req.query.from, "query param: from");
      const find = (s: IndexSnapshot) => (from === undefined ? resolveEmbed(link, s) : resolveMarkdownEmbed(link, from, s));
      // A miss, or a path answered by another file of the same name, is
      // checked again on a fresh index (lookUp): the file may be new.
      const matched = (p: string) => (from === undefined ? embedPathMatched(link, p) : markdownEmbedPathMatched(link, from, p));
      const resolved = await lookUp(index, find, matched);
      const body: ResolveEmbedResponse = resolved === null ? { path: null } : { path: resolved, ...(await attachments.info(resolved)) };
      res.status(200).json(body);
    }),
  );

  // Serves an attachment's raw bytes (images, video, PDF embedded via
  // ![[file]]), unlike /file which always reads+returns as UTF-8 text --
  // that would corrupt binary content.
  //
  // A `Range: bytes=...` request gets a 206 with just that range: iOS's
  // AVPlayer won't play a video from a server that can't.
  // Several ranges, another unit or a header without `=` get the whole file
  // (a server may ignore Range); a bytes range that starts past the end,
  // or doesn't parse, gets a 416 (Express's req.range, range-parser).
  // asyncRoute like every async route: anything that throws below (a
  // header on a response that already ended, say) is an error response,
  // or nothing if the client is gone, never an unhandled rejection that
  // ends the process.
  app.get("/attachment", asyncRoute(async (req: Request, res: Response) => {
    const attachment = await vault.openAttachment(requiredString(req.query.path, "query param: path"));
    const ranges = req.range(attachment.size);
    if (ranges === -1) {
      res.status(416).setHeader("Content-Range", `bytes */${attachment.size}`);
      res.json({ error: "range not satisfiable" } satisfies ErrorResponse);
      return;
    }
    const range = Array.isArray(ranges) && ranges.type === "bytes" && ranges.length === 1 ? ranges[0] : undefined;
    const stream = await attachment.open(range);
    // If the client went away while the file was being opened, pipeline
    // throws at once (ERR_STREAM_UNABLE_TO_PIPE); close the file and drop
    // the response instead.
    if (res.destroyed) {
      stream.destroy();
      return;
    }
    try {
      res.setHeader("Accept-Ranges", "bytes");
      if (range) {
        res.status(206).setHeader("Content-Range", `bytes ${range.start}-${range.end}/${attachment.size}`);
        res.setHeader("Content-Length", range.end - range.start + 1);
      } else {
        res.status(200).setHeader("Content-Length", attachment.size);
      }
      res.type(attachment.mimeType);
      // Never let the client guess a different type, and never let an SVG run
      // script or load anything if it's opened directly.
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (attachment.mimeType === "image/svg+xml") {
        res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      }
    } catch (err) {
      // The file is open: close it before the error goes on (asyncRoute).
      stream.destroy();
      throw err;
    }
    // pipeline, not pipe: when the client goes away mid-stream (scrolling
    // past a GIF), pipe() left the file open, one fd per aborted request,
    // until the process ran out. pipeline closes both ends on
    // an abort or a read error; a cut-off response is all the client sees.
    pipeline(stream, res, () => {});
  }));

  // Every route throws instead of answering an error itself; this maps
  // each error to a JSON error and status. Anything unexpected is a JSON
  // 500 too, never Express's HTML page with a stack trace.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
    } else if (err instanceof BadRequest) {
      res.status(400).json({ error: err.message } satisfies ErrorResponse);
    } else if (err instanceof Forbidden) {
      res.status(403).json({ error: err.message } satisfies ErrorResponse);
    } else if (err instanceof NotFound) {
      res.status(404).json({ error: err.message } satisfies ErrorResponse);
    } else if (err instanceof VaultError) {
      res.status(STATUS_FOR[err.kind]).json({ error: err.message } satisfies ErrorResponse);
    } else if ((err as { type?: string }).type === "entity.parse.failed") {
      res.status(400).json({ error: "request body is not valid JSON" } satisfies ErrorResponse);
    } else {
      res.status(500).json({ error: "internal error" } satisfies ErrorResponse);
    }
  });

  return app;
}

// Only start listening when run directly (`npm start` / `ts-node src/server.ts`),
// not when imported by tests.
if (require.main === module) {
  // No default: a default pointing at the live vault meant a bare
  // `npm run dev` served (and POST /file/checkbox wrote to) the real vault.
  // docker-compose.yml sets it to the mounted /vault;
  // `npm run dev:test` sets it to the fixture runtime vault.
  const vaultRoot = (process.env.VAULT_ROOT ?? "").trim();
  if (!vaultRoot) {
    console.error("VAULT_ROOT is not set: point it at the vault to serve (docker-compose.yml sets /vault; for local work use `npm run dev:test`, the fixture vault)");
    process.exit(1);
  }
  const authToken = process.env.AUTH_TOKEN ?? "";
  const secretsDir = path.resolve(process.env.SECRETS_DIR ?? "secrets");
  const port = Number(process.env.PORT ?? 3000);

  // The demo server's reusable pairing code. Off unless
  // both variables are set; set but invalid stops the server, like
  // PUBLIC_URL. Never logged: the messages don't contain it.
  let demoPairing: DemoPairing | null;
  try {
    demoPairing = parseDemoPairing(process.env);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  // Without AUTH_TOKEN only paired devices get in, so the devices file
  // must exist (scripts/pair-device.sh creates it): with neither, nobody
  // could use the backend. The demo server's code pairs without it (its
  // first pairing creates the file).
  const devicesFile = path.join(secretsDir, "devices.json");
  if (!authToken && !demoPairing && !fs.existsSync(devicesFile)) {
    console.error(`Neither AUTH_TOKEN nor ${devicesFile}: pair a device first (scripts/pair-device.sh creates the file), or set AUTH_TOKEN`);
    process.exit(1);
  }
  // Pairing links name this backend. Without PUBLIC_URL they'd take the
  // request's Host header and scheme, which a client controls and which is
  // http behind a proxy, so it's required, as the CLI does.
  const publicUrl = (process.env.PUBLIC_URL ?? "").trim();
  if (!/^https?:\/\/[^/?#@\s]+(\/[^?#\s]*)?$/.test(publicUrl)) {
    console.error("PUBLIC_URL must be the backend's URL as the app reaches it (e.g. https://viewer.example.com): it goes into pairing links");
    process.exit(1);
  }

  // A failed move is logged, not fatal: a server that exits here would
  // crash-loop, and the vault itself is still readable.
  try {
    const moved = migrateViewerStateDir(vaultRoot);
    // Both folders at once means the old one came back (a rollback, or a
    // device syncing it back): worth a warning.
    if (moved) (moved.includes(" both ") ? console.warn : console.log)(moved);
  } catch (err) {
    console.error(`viewer state: could not move the state folder to .mdvju/: ${(err as Error).message}`);
  }

  const swept = sweepStaleTempFiles(vaultRoot);
  if (swept.length > 0) console.log(`removed ${swept.length} stale temp file(s): ${swept.join(", ")}`);

  const corsOrigin = (process.env.CORS_ORIGIN ?? "").trim() || undefined;
  const app = createApp({ vaultRoot, authToken, secretsDir, publicUrl, trustProxy: process.env.TRUST_PROXY, corsOrigin, demoPairing });
  const server = app.listen(port, () => {
    console.log(`mdvju backend listening on :${(server.address() as AddressInfo).port}, vault=${vaultRoot}`);
    console.log(`auth: device tokens (${devicesFile})${authToken ? " and the shared AUTH_TOKEN (transition)" : " only"}`);
    if (demoPairing) {
      const until = new Date(demoPairing.expiresAt).toISOString();
      const state = Date.now() < demoPairing.expiresAt ? `on until ${until}` : `expired at ${until}, refused`;
      console.log(`demo pairing code: ${state}, at most ${demoPairing.maxDevices} demo devices`);
    }
  });
  // Node as PID 1 (a container without init) ignores SIGTERM, so `docker
  // stop` waited 10 s and killed it. Now: no new
  // connections, the responses in flight finish (Node closes idle
  // keep-alive connections itself), then exit; after SHUTDOWN_GRACE_MS
  // exit anyway, within docker's 10 s. Writes are a temp
  // file renamed into place, so even that loses nothing. A second signal
  // kills at once (`once`).
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, shutdown);
}
