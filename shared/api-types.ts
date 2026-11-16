/**
 * The response shapes the backend sends and the app reads, and their
 * version. Both sides compile this file, so a shape can't change on one
 * side only.
 *
 * Plain TypeScript with no imports (see shared/fences.ts).
 */

/**
 * The shape version `GET /status` reports. Bump it on any breaking
 * response-shape change (a field renamed or removed, a type changed; e.g.
 * /recent's `results` going from path strings to `{path, mtimeMs}`,
 * 2026-09-28). An installed app built against another version shows an
 * "update required" screen instead of misreading a shape it wasn't built
 * for (found live, 2026-09-29: a stale prod build crashed on that change).
 */
export const API_VERSION = 1;

/**
 * The `error` of the 403 a demo device gets on the device-management
 * routes. The app tells it from the shared token's 403
 * by this text, to show the demo server's own message.
 */
export const DEMO_DEVICE_REFUSAL = "a demo device can't manage devices";

/** `GET /status`. */
export interface StatusResponse {
  apiVersion: number;
}

/** Any error the backend answers (4xx, 5xx): JSON with a message, never a page. */
export interface ErrorResponse {
  error: string;
}

/** A write's answer when there is nothing else to say (`DELETE /devices/:id`). */
export interface OkResponse {
  ok: true;
}

/** `GET /search`: matching note paths, best match first. */
export interface SearchResponse {
  results: string[];
}

/** `GET /resolve`: the vault-relative path the link names, or null if none. (`GET /resolve-embed` answers a ResolveEmbedResponse.) */
export interface ResolveResponse {
  path: string | null;
}

/** `POST /file/checkbox`'s body: `line` is 1-indexed in the raw note, `expectedLine` that line as the client has it. */
export interface CheckboxRequest {
  path: string;
  line: number;
  checked: boolean;
  expectedLine: string;
  /** The ETag of the version the client has. */
  baseEtag?: string;
}

/** `POST /file/checkbox`: the ETag of the note as written, and whether the write went onto exactly the `baseEtag` version. */
export interface CheckboxResponse {
  ok: true;
  etag: string;
  baseMatched: boolean;
}

/** `POST /pair`'s body. */
export interface PairRequest {
  code: string;
  deviceName?: string;
}

/**
 * `GET /attachment-key`: the read-only key the app puts in `/attachment`
 * URLs as `?key=`. Only `/attachment` accepts it.
 */
export interface AttachmentKey {
  key: string;
}

/**
 * `POST /pair`: the new device and its token. The token
 * is called `refreshToken` so that short-lived access tokens
 * can be added without a rename: until then the app sends it as its
 * Bearer token, and a later version would add `POST /token` to trade it for an
 * `accessToken`.
 */
export interface PairResponse {
  deviceId: string;
  name: string;
  refreshToken: string;
}

/** `POST /pairing-codes`: a single-use code (10 minutes) and its pairing link (shared/pair-link.ts). */
export interface PairingCodeResponse {
  code: string;
  /** ISO 8601. */
  expiresAt: string;
  link: string;
}

/** `GET /devices`: the active (not revoked) devices. */
export interface DeviceList {
  devices: DeviceInfo[];
}

export interface DeviceInfo {
  id: string;
  name: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601, or null if it never made a request after pairing. */
  lastSeenAt: string | null;
  /** True for the device that asked. */
  current: boolean;
  /** Who made the pairing code it used: a device id, "cli" (the server's scripts), or null (paired before this was recorded). */
  pairedBy: string | null;
  /** That device's name, also if it was revoked since; null for "cli" and null. */
  pairedByName: string | null;
}

/** Home page + favourites, shared by every install on one backend. */
export interface ViewerState {
  homePath: string | null;
  favourites: string[];
}

/** Folders and notes for the file opener: one level (/tree) or the whole vault (/paths). Vault-relative paths, each list sorted. */
export interface DirectoryListing {
  folders: string[];
  files: string[];
  /**
   * The folder source only: this level may be missing
   * entries, because its folder couldn't be read yet (an iCloud folder still
   * arriving) or it's empty in a listing a newer one is replacing. The
   * opener says "Loading…" for an empty one, not "No notes in this folder.",
   * and asks again when the next listing is announced. Never sent by the
   * backend.
   */
  incomplete?: true;
}

/**
 * `GET /resolve-embed` (with `from`, a Markdown image in
 * that note). `size` (bytes) and `mtimeMs` for a
 * file `/attachment` serves; `width` and `height` (pixels, EXIF orientation
 * applied) for a png, jpg, gif or webp whose header parses.
 * Added fields, so an older app reads `path` as before.
 */
export interface ResolveEmbedResponse {
  path: string | null;
  size?: number;
  mtimeMs?: number;
  width?: number;
  height?: number;
}

export interface RecentFile {
  path: string;
  mtimeMs: number;
}

export interface RecentFilesPage {
  results: RecentFile[];
  /** Pass back as `cursor` to fetch the next page; null once exhausted. */
  nextCursor: string | null;
}
