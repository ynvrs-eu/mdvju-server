/**
 * The file opener's queries over a vault snapshot: name search, recent
 * notes, every path, and one folder level. The backend's /search, /recent
 * and /paths answer with these; the app's folder source will too, so the
 * two can't disagree.
 *
 * Plain TypeScript, importing only from shared/ (see shared/fences.ts).
 */

import type { DirectoryListing, RecentFile, RecentFilesPage } from "./api-types";
import { normalizeVaultPath } from "./vault-path-rules";
import type { IndexedNote, VaultSnapshot } from "./vault-snapshot";

export const SEARCH_RESULTS_LIMIT = 30;
export const RECENT_FILES_LIMIT = 15;

/**
 * Filename/path quick-switcher search, not full-text content search: notes
 * whose path contains `q` (trimmed, case-insensitive). A query shorter than
 * 2 characters finds nothing.
 */
export function searchNotes(snapshot: VaultSnapshot, q: string, limit = SEARCH_RESULTS_LIMIT): string[] {
  if (q.trim().length < 2) return [];

  const needle = q.trim().toLowerCase();
  const files = snapshot.notes.map((n) => n.path);
  const matches = files.filter((f) => f.toLowerCase().includes(needle));

  // Basename matches first (the file itself, not just a containing
  // folder name), then shorter paths -- both are decent proxies for
  // "more likely what you meant" without needing real fuzzy scoring.
  matches.sort((a, b) => {
    const aBase = (a.split("/").pop() ?? a).toLowerCase().includes(needle);
    const bBase = (b.split("/").pop() ?? b).toLowerCase().includes(needle);
    if (aBase !== bBase) return aBase ? -1 : 1;
    return a.length - b.length;
  });

  return matches.slice(0, limit);
}

export interface RecentCursor {
  mtimeMs: number;
  /** null: a bare-number cursor, "older than this mtime". */
  path: string | null;
}

/**
 * The /recent cursor is the (mtimeMs, path) of the last item served, as
 * "<mtimeMs>|<path>", and the order is newest first, then by path. With
 * mtime alone, files sharing the last item's mtime were skipped on the
 * next page. A bare number (what older app builds
 * send back) still means "older than this mtime". Opaque to the app.
 *
 * Throws on an empty string or a non-numeric mtime.
 */
export function parseRecentCursor(s: string): RecentCursor {
  const bar = s.indexOf("|");
  const mtimeMs = Number(bar === -1 ? s : s.slice(0, bar));
  if (s === "" || Number.isNaN(mtimeMs)) throw new Error("invalid cursor");
  return { mtimeMs, path: bar === -1 ? null : s.slice(bar + 1) };
}

/**
 * One page of the most recently modified notes, newest first, after
 * `cursor` (null: from the start). Notes with nothing to show (empty, or
 * frontmatter-only) are skipped: `isDisplayable` is asked in mtime order
 * only until the page is full, so a large vault doesn't need every note
 * read. An `isDisplayable` that throws (the note was deleted meanwhile)
 * skips that note.
 *
 * `nextCursor` is the last item's cursor when a further page might exist,
 * or null once the candidates are exhausted.
 */
export async function recentPage(
  notes: IndexedNote[],
  cursor: RecentCursor | null,
  limit: number,
  isDisplayable: (path: string) => boolean | Promise<boolean>,
): Promise<RecentFilesPage> {
  const byRecency = (a: { mtimeMs: number; path: string }, b: { mtimeMs: number; path: string }) =>
    b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  const files = notes
    .filter((f) => {
      if (cursor === null) return true;
      if (cursor.path === null) return f.mtimeMs < cursor.mtimeMs;
      return byRecency(f, { mtimeMs: cursor.mtimeMs, path: cursor.path }) > 0;
    })
    .sort(byRecency);

  const results: RecentFile[] = [];
  let exhausted = true;
  for (const f of files) {
    if (results.length >= limit) {
      exhausted = false; // hit the page limit before running out of candidates -- more may exist
      break;
    }
    let displayable: boolean;
    try {
      displayable = await isDisplayable(f.path);
    } catch {
      continue; // race with a delete -- skip
    }
    if (displayable) {
      results.push({ path: f.path, mtimeMs: f.mtimeMs });
    }
  }

  const last = results[results.length - 1];
  const nextCursor = !exhausted && last ? `${last.mtimeMs}|${last.path}` : null;
  return { results, nextCursor };
}

/** Every folder and note in the snapshot: the same entries /tree lists, all levels at once. */
export function allPaths(snapshot: VaultSnapshot): DirectoryListing {
  return { folders: snapshot.folders, files: snapshot.notes.map((n) => n.path) };
}

/**
 * One folder level from the snapshot, as the backend's /tree lists it from
 * the disk: subfolders and notes directly inside `dir` ("" is the root),
 * as vault-relative paths, each list sorted by name (case-insensitive).
 * Null if `dir` is refused by the path rules or isn't a folder in the
 * snapshot.
 *
 * The backend keeps its live directory read for /tree; this is for a
 * source that has only a snapshot.
 */
export function listLevel(snapshot: VaultSnapshot, dir: string): DirectoryListing | null {
  const level = normalizeVaultPath(dir);
  if (level === null) return null;
  if (level !== "" && !snapshot.folders.includes(level)) return null;

  const parentOf = (p: string) => {
    const slash = p.lastIndexOf("/");
    return slash === -1 ? "" : p.slice(0, slash);
  };
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });
  return {
    folders: snapshot.folders.filter((f) => parentOf(f) === level).sort(byName),
    files: snapshot.notes.map((n) => n.path).filter((p) => parentOf(p) === level).sort(byName),
  };
}
