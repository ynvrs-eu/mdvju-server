import * as fs from "fs";
import * as path from "path";
import type { ViewerState } from "../shared/api-types";
import { parseViewerState } from "../shared/viewer-state";
import { writeFileAtomic } from "./atomic-write";

/**
 * Home page + favourites, shared across every install that talks to this
 * backend. Lives in the vault itself as a hidden file, so it
 * rides along with the vault's own sync/backup -- and the dot-prefixed
 * folder keeps it out of /search, /recent and wikilink resolution.
 */

export const VIEWER_STATE_DIR = ".mdvju";
/** The folder's name before the mdvju rename. */
export const OLD_VIEWER_STATE_DIR = ".obsidian-mobile-viewer";
const VIEWER_STATE_PATH = path.join(VIEWER_STATE_DIR, "state.json");

/** The modification time of `<dir>/state.json` in ms, or -Infinity if there is none. */
function stateMtime(dir: string): number {
  try {
    return fs.statSync(path.join(dir, "state.json")).mtimeMs;
  } catch {
    return -Infinity;
  }
}

/** `<dir>.bak`, or `<dir>.bak-<ms>` if that is taken: an earlier backup is never overwritten. */
function backupName(dir: string, now: number): string {
  return fs.existsSync(`${dir}.bak`) ? `${dir}.bak-${now}` : `${dir}.bak`;
}

/**
 * Moves the state folder from its old name to `.mdvju/`; the
 * server runs it once at startup. The vault syncs (Syncthing), so a device
 * that was offline during the move can sync the old folder back, and both
 * can exist. The rule:
 *
 * - Only the old folder: it's renamed to `.mdvju`.
 * - Only `.mdvju` (or neither): nothing to do.
 * - Both: the folder whose `state.json` is newer wins (a missing one counts
 *   as oldest; a tie keeps `.mdvju`). The loser is renamed to `<name>.bak`
 *   (`<name>.bak-<ms>` if a `.bak` is there already), so nothing is merged
 *   or deleted. If the old folder won, it then becomes `.mdvju`.
 *
 * "Newer" relies on two things: Syncthing keeps file mtimes when it syncs,
 * and only this backend writes `state.json`. It runs only at
 * startup: an old folder that comes back later stays until the next start,
 * and that start logs it as a warning (MR2).
 *
 * Returns a line saying what it did, for the log, or null if nothing.
 */
export function migrateViewerStateDir(vaultRoot: string, now: number = Date.now()): string | null {
  const oldDir = path.join(vaultRoot, OLD_VIEWER_STATE_DIR);
  const newDir = path.join(vaultRoot, VIEWER_STATE_DIR);
  if (!fs.existsSync(oldDir)) return null;
  if (!fs.existsSync(newDir)) {
    fs.renameSync(oldDir, newDir);
    return `viewer state: moved ${OLD_VIEWER_STATE_DIR}/ to ${VIEWER_STATE_DIR}/`;
  }
  if (stateMtime(oldDir) > stateMtime(newDir)) {
    const bak = backupName(newDir, now);
    fs.renameSync(newDir, bak);
    fs.renameSync(oldDir, newDir);
    return `viewer state: both ${OLD_VIEWER_STATE_DIR}/ and ${VIEWER_STATE_DIR}/ existed; the old one had the newer state.json, so it is now ${VIEWER_STATE_DIR}/ and the other is ${path.basename(bak)}/`;
  }
  const bak = backupName(oldDir, now);
  fs.renameSync(oldDir, bak);
  return `viewer state: both ${OLD_VIEWER_STATE_DIR}/ and ${VIEWER_STATE_DIR}/ existed; kept ${VIEWER_STATE_DIR}/ (newer state.json), the old one is now ${path.basename(bak)}/`;
}

/**
 * Reads the viewer state file -- empty defaults if it doesn't exist yet
 * (shared/viewer-state.ts parseViewerState, as the folder source reads its
 * copy). Throws if it exists but can't be parsed: a read-modify-write on top of
 * empty defaults would wipe every favourite, so the
 * write paths must refuse instead. GET /state catches and shows defaults.
 */
export function readViewerState(vaultRoot: string): ViewerState {
  let raw: string | null;
  try {
    raw = fs.readFileSync(path.join(vaultRoot, VIEWER_STATE_PATH), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    raw = null;
  }
  return parseViewerState(raw);
}

/** Writes the viewer state file, creating its hidden folder on first write. */
export function writeViewerState(vaultRoot: string, state: ViewerState): void {
  const full = path.join(vaultRoot, VIEWER_STATE_PATH);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  writeFileAtomic(full, JSON.stringify(state, null, 2) + "\n");
}
