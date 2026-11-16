import type { VaultSnapshot } from "./vault-snapshot";
import { normalizeVaultPath } from "./vault-path-rules";

/**
 * Resolves the target of an Obsidian `[[wikilink]]` to a vault-relative
 * file path, following (and, for aliases, deliberately extending) stock
 * Obsidian's resolution rules:
 *
 *  1. Normalized filename match: case-insensitive, with spaces/-/_
 *     treated as equivalent and a trailing ".md" ignored. `linkText` may
 *     be a bare basename ("My Daily Routine") or include a path
 *     ("References/sysadm/index") -- a path match is tried first, then
 *     falls back to basename-only matching.
 *  2. If the basename match is ambiguous (multiple files share it),
 *     resolve to the shortest distinguishing path (fewest path
 *     segments, then shortest string as a deterministic tiebreak) --
 *     this mirrors Obsidian's own real tiebreak behaviour.
 *  3. If no filename match exists at all, fall back to matching against
 *     each file's frontmatter `aliases:` list. Stock Obsidian does NOT
 *     do this at link-click time (it's community-plugin territory) --
 *     this is a deliberate improvement decided in the project plan.
 *
 * Returns the matched note's vault-relative path, or null if nothing
 * resolves. Pure: it looks only at the index snapshot.
 */
export function resolveWikilink(linkText: string, vault: VaultSnapshot): string | null {
  // Obsidian's suffixes name a place in the note or how it's shown, not a
  // different note: `|alias`, `#Heading`, `#^block`.
  // A link that is only `#Heading` points into the current note, which the
  // server can't know about, so it doesn't resolve here.
  const cleaned = linkText.split("|")[0].split("#")[0].trim();
  if (cleaned.length === 0) return null;

  const files = vault.notes.map((n) => n.path);
  const targetNormalized = normalizePath(cleaned);
  const targetBasename = normalizeSegment(basenameNoExt(cleaned));

  // Pass 1: full (normalized) path match -- only meaningful when the
  // link text itself contains a path separator.
  if (cleaned.includes("/")) {
    const pathMatches = files.filter((f) => normalizePath(stripMdExt(f)) === targetNormalized);
    if (pathMatches.length > 0) {
      return pickShortest(pathMatches);
    }
  }

  // Pass 2: basename match across the whole vault.
  const basenameMatches = files.filter(
    (f) => normalizeSegment(basenameNoExt(f)) === targetBasename,
  );
  if (basenameMatches.length > 0) {
    return pickShortest(basenameMatches);
  }

  // Pass 3: frontmatter aliases (Obsidian doesn't do this natively --
  // our deliberate improvement).
  const aliasMatches = vault.notes
    .filter((n) => n.aliases.some((a) => normalizeSegment(a) === targetBasename))
    .map((n) => n.path);
  if (aliasMatches.length > 0) {
    return pickShortest(aliasMatches);
  }

  return null;
}

/**
 * Resolves the target of an Obsidian `![[embed]]` (an attachment, or a note)
 * to a vault-relative file path.
 *
 * Same shortest-path/basename matching as resolveWikilink, but against
 * every file in the vault rather than just markdown ones, and without
 * stripping a ".md" extension or falling back to frontmatter aliases --
 * neither makes sense for a binary attachment, which is always
 * referenced by its real, full filename (extension included).
 */
/** An attachment's extension (and common file types the app doesn't show): such a target is never a note. */
const ATTACHMENT_LIKE = /\.(png|jpe?g|gif|webp|svg|bmp|heic|tiff?|pdf|mp4|m4v|mov|webm|mkv|avi|mp3|m4a|wav|ogg|flac|zip|docx?|xlsx?|pptx?|csv|canvas)$/i;

export function resolveEmbed(linkText: string, vault: VaultSnapshot): string | null {
  // Same suffix strip as resolveWikilink: `![[pic.png|220]]` (a display
  // width) and `![[pic.png#x]]` still name pic.png.
  const cleaned = linkText.split("|")[0].split("#")[0].trim();
  if (cleaned.length === 0) return null;

  const files = vault.files;

  if (cleaned.includes("/")) {
    const targetNormalized = cleaned.split("/").map(normalizeSegment).join("/");
    const pathMatches = files.filter((f) => f.split("/").map(normalizeSegment).join("/") === targetNormalized);
    if (pathMatches.length > 0) {
      return pickShortest(pathMatches);
    }
  }

  const targetBasename = normalizeSegment(cleaned.split("/").pop() ?? cleaned);
  const basenameMatches = files.filter((f) => normalizeSegment(f.split("/").pop() ?? f) === targetBasename);
  if (basenameMatches.length > 0) {
    return pickShortest(basenameMatches);
  }

  // No file has that name: a note embed names
  // its note as a [[wikilink]] does, without ".md", or by an alias. Not a
  // target with an attachment's extension: a missing `pic.png` stays
  // missing, never a note with that alias or name.
  if (ATTACHMENT_LIKE.test(cleaned)) return null;
  return resolveWikilink(cleaned, vault);
}

/**
 * Resolves the target of a standard Markdown image, `![alt](target)`, in
 * the note at `fromNote`, to a vault-relative
 * file path, or null. `target` comes decoded (no `%20`, no `<...>`).
 *
 *  - `./x` or `../x` (a `..` anywhere): relative to the note's folder only.
 *  - `/x`: from the vault root only.
 *  - Anything else: relative to the note's folder; then from the vault
 *    root; then the file whose path ends with the target, by whole
 *    segments, fewest segments first (Obsidian's "shortest path" links).
 *
 * Case-insensitive, the exact case first. A path that climbs above the
 * vault root, or has a segment starting with "." (cleanVaultPath's rule),
 * is null, with no fallback: an escape never resolves to some other file
 * of the same name.
 */
export function resolveMarkdownEmbed(target: string, fromNote: string, vault: VaultSnapshot): string | null {
  const note = normalizeVaultPath(fromNote);
  const cleaned = target.trim();
  if (note === null || cleaned === "") return null;
  const folder = note.split("/").slice(0, -1);
  const segments = cleaned.split("/");
  const files = vault.files;
  const find = (p: string | null): string | null => {
    if (p === null) return null;
    if (files.includes(p)) return p;
    const lower = p.toLowerCase();
    const matches = files.filter((f) => f.toLowerCase() === lower);
    return matches.length > 0 ? pickShortest(matches) : null;
  };

  if (cleaned.startsWith("/")) return find(joinVaultPath([], segments));
  const relative = joinVaultPath(folder, segments);
  if (segments.includes(".") || segments.includes("..")) return find(relative);
  const fromRoot = joinVaultPath([], segments);
  const found = find(relative) ?? find(fromRoot);
  if (found !== null || fromRoot === null) return found;
  const tail = fromRoot.toLowerCase();
  // Never a file the vault path rule refuses, even if a snapshot lists one.
  const matches = files.filter((f) => f.toLowerCase().endsWith(`/${tail}`) && normalizeVaultPath(f) === f);
  return matches.length > 0 ? pickShortest(matches) : null;
}

/**
 * `segments` applied to the folder `base`: "" and "." are skipped, ".."
 * goes up one. Null if it goes above the root, if a segment (or a part of
 * it between `\`) starts with ".", or if nothing is left.
 */
function joinVaultPath(base: string[], segments: string[]): string | null {
  const out = [...base];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    if (segment.split("\\").some((part) => part.startsWith("."))) return null;
    out.push(segment);
  }
  return out.length > 0 ? out.join("/") : null;
}

function pickShortest(candidates: string[]): string {
  return [...candidates].sort((a, b) => {
    const segsA = a.split("/").length;
    const segsB = b.split("/").length;
    if (segsA !== segsB) return segsA - segsB;
    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b);
  })[0];
}

function stripMdExt(p: string): string {
  return p.replace(/\.md$/i, "");
}

function basenameNoExt(p: string): string {
  const base = p.split("/").pop() ?? p;
  return stripMdExt(base);
}

/** lowercase, spaces/-/_ treated as equivalent (collapsed to a single space) */
function normalizeSegment(s: string): string {
  return s
    .toLowerCase()
    .replace(/[-_\s]+/g, " ")
    .trim();
}

function normalizePath(p: string): string {
  return stripMdExt(p)
    .split("/")
    .map(normalizeSegment)
    .join("/");
}
