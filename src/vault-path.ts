import * as fs from "fs";
import * as path from "path";
import { normalizeVaultPath } from "../shared/vault-path-rules";

/**
 * Resolves a vault-relative path against vaultRoot, guarding against
 * anything that would reach outside the vault's visible notes:
 *
 * - path traversal (e.g. "../../etc/passwd", or an absolute path that
 *   would otherwise escape the vault root);
 * - any path segment starting with "." -- dot-folders hold plugin
 *   config, API keys and .git, none of it meant for the app; this also refuses "..", even when it stays inside;
 * - symlinks that lead out of the vault: the deepest existing part of
 *   the path is resolved with realpath and must still be inside the
 *   vault's own realpath. A path that doesn't exist
 *   yet (a 404, or POST /home's unchecked path) is checked as far as
 *   it exists.
 *
 * - a symlink inside the vault whose target is in a dot-folder: the dot
 *   rule applies to the real path too, not just the requested one.
 *
 * Returns the realpath (for a path that doesn't exist yet, the realpath
 * of its deepest existing ancestor plus the rest), or null if the path is
 * refused. Callers operate on the real file, so a write through an
 * in-vault symlink replaces the target, not the link, and a
 * link swapped in after this check isn't followed.
 */
export function resolveVaultPath(vaultRoot: string, relativePath: string): string | null {
  const root = path.resolve(vaultRoot);
  // An absolute-looking relativePath would make resolve() ignore
  // vaultRoot entirely: shared/vault-path-rules.ts strips any leading "/"
  // first, so "/etc/passwd" is vault-relative, and refuses dot segments.
  // Its empty-segment drop is what resolve() does anyway; it's the same
  // rule the folder source applies.
  const cleaned = normalizeVaultPath(relativePath);
  if (cleaned === null) return null;

  const resolved = path.resolve(root, cleaned);
  if (!isInside(root, resolved)) return null;

  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return null;
  }
  let existing = resolved;
  while (!fs.existsSync(existing) && existing !== root) existing = path.dirname(existing);
  let real: string;
  try {
    real = path.join(fs.realpathSync(existing), path.relative(existing, resolved));
  } catch {
    return null;
  }
  if (!isInside(realRoot, real)) return null;
  if (path.relative(realRoot, real).split(path.sep).some((segment) => segment.startsWith("."))) return null;
  return real;
}

function isInside(root: string, p: string): boolean {
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  return p === root || p.startsWith(rootWithSep);
}
