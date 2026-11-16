/**
 * The string half of the vault path rule: what a vault-relative path from
 * a request may look like before it touches any file system. The backend's
 * resolveVaultPath (src/vault-path.ts) adds the real-path half
 * (inside the vault, no symlink out) on top.
 *
 * Plain TypeScript, importing only from shared/ (see shared/fences.ts).
 */

/**
 * Whether a vault path names a note: it ends in ".md", in any case. The
 * one "is a note" rule for the backend, the folder source and the app.
 */
export function isNotePath(p: string): boolean {
  return p.toLowerCase().endsWith(".md");
}

/**
 * `rel` without its leading `/` or `\` characters, so "/etc/passwd" is
 * vault-relative, not absolute. Null if any segment (split on `/` or `\`)
 * starts with "." -- dot-folders hold plugin config, API keys and .git,
 * none of it meant for the app; this also refuses
 * "." and "..".
 */
export function cleanVaultPath(rel: string): string | null {
  const cleaned = rel.replace(/^[/\\]+/, "");
  if (cleaned.split(/[/\\]/).some((segment) => segment.startsWith("."))) return null;
  return cleaned;
}

/**
 * `rel` as one vault-relative path: cleaned (cleanVaultPath), then with its
 * empty segments dropped, so "A//B.md" is "A/B.md" and "A/B/" is "A/B", as
 * the backend's path.resolve has it. "" (or only slashes) is
 * the vault's root. Null if cleanVaultPath refuses it. Only "/" separates
 * segments here; a "\\" stays in the name, as on the backend's disk.
 */
export function normalizeVaultPath(rel: string): string | null {
  const cleaned = cleanVaultPath(rel);
  if (cleaned === null) return null;
  return cleaned
    .split("/")
    .filter((segment) => segment !== "")
    .join("/");
}
