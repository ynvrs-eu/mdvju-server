// Test-only helpers shared by the backend tests: a throwaway
// temp vault, the app over it, every route, and a supertest client that
// sends the bearer token. Excluded from the production build in
// tsconfig.json.

import request from "supertest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createApp, type AppConfig } from "./server";

export interface TestVault {
  /** The vault root. */
  root: string;
  /** A sibling directory outside the vault, the target of escape symlinks. */
  outside: string;
  /** A sibling directory for the backend's SECRETS_DIR (devices.json, server-secret); empty to start with. */
  secrets: string;
  /** Writes a file (creating parent folders) relative to `dir`, the vault root by default. Returns its full path. */
  put(relPath: string, content: string | Buffer, dir?: string): string;
  /** Reads a file relative to `dir`, the vault root by default, as UTF-8. */
  read(relPath: string, dir?: string): string;
  /** Restores write permission on anything a test chmod'ed, then removes the vault and `outside`. */
  cleanup(): void;
}

/** Creates `<tmp>/vault`, `<tmp>/outside` and `<tmp>/secrets`, and writes `files` into the vault. */
export function makeVault(files: Record<string, string | Buffer> = {}): TestVault {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omv-test-"));
  const root = path.join(base, "vault");
  const outside = path.join(base, "outside");
  const secrets = path.join(base, "secrets");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.mkdirSync(secrets);

  const put = (relPath: string, content: string | Buffer, dir = root) => {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
  };
  const read = (relPath: string, dir = root) => fs.readFileSync(path.join(dir, relPath), "utf-8");
  for (const [relPath, content] of Object.entries(files)) put(relPath, content);

  return {
    root,
    outside,
    secrets,
    put,
    read,
    cleanup() {
      restoreWritable(base);
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

function restoreWritable(dir: string) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    fs.chmodSync(full, entry.isDirectory() ? 0o755 : 0o644);
    if (entry.isDirectory()) restoreWritable(full);
  }
}

/**
 * Creates `vault/escape -> outside/`, a directory symlink leading out of the
 * vault, with a note, a task note and an image in the outside directory.
 */
export function makeEscapeSymlink(v: TestVault) {
  v.put("secret.md", "# Outside the vault\n", v.outside);
  v.put("tasks.md", "- [ ] outside task\n", v.outside);
  v.put("pic.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]), v.outside);
  fs.symlinkSync(v.outside, path.join(v.root, "escape"), "dir");
}

/** The app over `v`, with `v.secrets` as its secrets folder; `config` adds to or overrides that. */
export function makeApp(v: TestVault, config: Partial<AppConfig> = {}) {
  return createApp({ vaultRoot: v.root, secretsDir: v.secrets, ...config });
}

/**
 * Every product route, with a request that passes auth and succeeds over
 * a vault holding `Note.md` ("# Note\n\n- [ ] task\n") and `pic.png`.
 * The device routes (/pair, /pairing-codes, /devices) are DEVICE_ROUTES.
 */
export const ROUTES: { method: "get" | "post"; url: string; query?: Record<string, string>; body?: object }[] = [
  { method: "get", url: "/status" },
  { method: "get", url: "/attachment-key" },
  { method: "get", url: "/file", query: { path: "Note.md" } },
  { method: "post", url: "/file/checkbox", body: { path: "Note.md", line: 3, checked: true, expectedLine: "- [ ] task" } },
  { method: "get", url: "/state" },
  { method: "post", url: "/home", body: { path: "Note.md" } },
  { method: "post", url: "/favourites/toggle", body: { path: "Note.md" } },
  { method: "get", url: "/search", query: { q: "note" } },
  { method: "get", url: "/tree" },
  { method: "get", url: "/paths" },
  { method: "get", url: "/recent" },
  { method: "get", url: "/resolve", query: { link: "Note" } },
  { method: "get", url: "/resolve-embed", query: { link: "pic.png" } },
  { method: "get", url: "/attachment", query: { path: "pic.png" } },
];

/** The one route besides POST /pair that takes no credential: the healthcheck (B-health-01). */
export const OPEN_ROUTES: { method: "get"; url: string }[] = [{ method: "get", url: "/health" }];

/** The device routes, tested in devices.test.ts: POST /pair takes no credential, the rest a paired device's. */
export const DEVICE_ROUTES: { method: "get" | "post" | "delete"; url: string }[] = [
  { method: "post", url: "/pair" },
  { method: "post", url: "/pairing-codes" },
  { method: "get", url: "/devices" },
  { method: "delete", url: "/devices/:id" },
];

type App = Parameters<typeof request>[0];

/** Requests to `app` that carry `Authorization: Bearer <token>`. */
export function api(app: App, token: string) {
  const auth = `Bearer ${token}`;
  return {
    get: (url: string, query: Record<string, string> = {}) => request(app).get(url).query(query).set("Authorization", auth),
    post: (url: string, body?: object) => {
      const req = request(app).post(url).set("Authorization", auth);
      return body === undefined ? req : req.send(body);
    },
  };
}
