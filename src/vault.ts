import * as fs from "fs";
import { once } from "events";
import * as path from "path";
import type { DirectoryListing, ViewerState } from "../shared/api-types";
import { ATTACHMENT_MIME_TYPES } from "../shared/attachments";
import { NOTE_TOO_LARGE_MESSAGE, noteTooLarge } from "../shared/note-size";
import { isNotePath } from "../shared/vault-path-rules";
import { toggleFavourite } from "../shared/viewer-state";
import { ConflictError, GroupError, writeFileAtomic } from "./atomic-write";
import { resolveVaultPath } from "./vault-path";
import { readViewerState, writeViewerState } from "./viewer-state";

export type VaultErrorKind = "invalid-path" | "not-found" | "conflict" | "too-large" | "io";

/**
 * The one error type the vault throws. The routes map `kind` to a status
 * (400, 404, 409, 413, 500) and send `message` as the JSON error.
 */
export class VaultError extends Error {
  constructor(
    readonly kind: VaultErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

export interface Attachment {
  mimeType: string;
  size: number;
  mtimeMs: number;
  /** Opens the file, or the inclusive byte range `start`..`end` of it, for streaming. */
  open(range?: { start: number; end: number }): Promise<fs.ReadStream>;
}

export type Vault = ReturnType<typeof openVault>;

/**
 * Every read and write the API makes against the vault folder. Path rules
 * (inside the vault, no dot segments, no symlink out) and the file-level
 * safety of a write live here, so a route only parses its request and calls
 * one of these.
 */
export function openVault(root: string) {
  function resolve(rel: string): string {
    const resolved = resolveVaultPath(root, rel);
    if (resolved === null) throw new VaultError("invalid-path", "path escapes vault root");
    return resolved;
  }

  function resolveNote(rel: string): string {
    const resolved = resolve(rel);
    // Notes only: attachments have their own allowlist, and nothing else
    // in the vault (.json config, .pptx, ...) is for the app.
    if (!isNotePath(resolved)) {
      throw new VaultError("invalid-path", "only .md notes can be read or written");
    }
    return resolved;
  }

  // Attachments have their own allowlist, by extension (shared/attachments.ts).
  function resolveAttachment(rel: string): { resolved: string; mimeType: string } {
    const resolved = resolve(rel);
    const mimeType = ATTACHMENT_MIME_TYPES[rel.slice(rel.lastIndexOf(".")).toLowerCase()];
    if (!mimeType) throw new VaultError("invalid-path", "unsupported attachment type");
    return { resolved, mimeType };
  }

  function readError(err: unknown): VaultError {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new VaultError("not-found", "file not found");
    return new VaultError("io", "failed to read file");
  }

  function readFile(resolved: string): string {
    try {
      return fs.readFileSync(resolved, "utf-8");
    } catch (err) {
      throw readError(err);
    }
  }

  function statFile(resolved: string): fs.Stats {
    try {
      return fs.statSync(resolved);
    } catch (err) {
      throw readError(err);
    }
  }

  // A corrupt state.json throws here, so a read-modify-write refuses
  // instead of wiping every favourite.
  function updateState(edit: (state: ViewerState) => ViewerState): ViewerState {
    try {
      const state = edit(readViewerState(root));
      writeViewerState(root, state);
      return state;
    } catch {
      throw new VaultError("io", "failed to update state");
    }
  }

  return {
    /** A note over NOTE_MAX_BYTES is refused before it's read. */
    readNote(rel: string): string {
      const resolved = resolveNote(rel);
      if (noteTooLarge(statFile(resolved).size)) throw new VaultError("too-large", NOTE_TOO_LARGE_MESSAGE);
      return readFile(resolved);
    },

    /**
     * Replaces a note's content with `edit(current)`, atomically. `edit`
     * may throw a VaultError (a "conflict" when the content isn't what the
     * caller expected); the file is untouched in that case. Returns the
     * new content. A note over NOTE_MAX_BYTES is refused before it's read,
     * the same as readNote: the app never opens one, but the
     * API can still be called directly.
     */
    updateNote(rel: string, edit: (content: string) => string): string {
      const resolved = resolveNote(rel);
      const before = statFile(resolved);
      if (noteTooLarge(before.size)) throw new VaultError("too-large", NOTE_TOO_LARGE_MESSAGE);
      const updated = edit(readFile(resolved));
      try {
        writeFileAtomic(resolved, updated, before);
      } catch (err) {
        if (err instanceof ConflictError) {
          throw new VaultError("conflict", "file changed while it was being written -- reload and retry");
        }
        if (err instanceof GroupError) throw new VaultError("io", err.message);
        throw new VaultError("io", "failed to write file");
      }
      return updated;
    },

    listDir(rel: string): DirectoryListing {
      if (resolveVaultPath(root, rel) === null) throw new VaultError("invalid-path", "invalid path");
      const listing = listDirectory(root, rel);
      if (listing === null) throw new VaultError("not-found", "directory not found");
      return listing;
    },

    /** Home page + favourites. Empty defaults when the state file is missing or corrupt. */
    readState(): ViewerState {
      try {
        return readViewerState(root);
      } catch {
        return { homePath: null, favourites: [] };
      }
    },

    setHome(rel: string): ViewerState {
      resolve(rel);
      return updateState((state) => ({ ...state, homePath: rel }));
    },

    // A toggle, not a client-sent full list: the read-modify-write here
    // means a stale client copy can't clobber favourites added elsewhere.
    toggleFavourite(rel: string): ViewerState {
      resolve(rel);
      return updateState((state) => toggleFavourite(state, rel));
    },

    /**
     * Finds an attachment, to stream whole or as a byte range (video seeks). Non-blocking (not readFileSync): a note can embed a
     * dozen-plus images at once, all requested concurrently, and a
     * synchronous read stalls every other request (found live: GIFs stuck
     * on a permanent spinner).
     */
    async openAttachment(rel: string): Promise<Attachment> {
      const { resolved, mimeType } = resolveAttachment(rel);
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(resolved);
      } catch {
        throw new VaultError("not-found", "file not found");
      }
      return {
        mimeType,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        async open(range) {
          // Wait for the open, so a failure to open (EACCES, EMFILE) is
          // still an error response rather than a cut-off stream.
          const stream = fs.createReadStream(resolved, range);
          try {
            await once(stream, "open");
          } catch {
            throw new VaultError("io", "failed to read attachment");
          }
          return stream;
        },
      };
    },

    /**
     * The first `n` bytes of an attachment (fewer if the file is shorter),
     * for its image size (/resolve-embed). The same checks as
     * openAttachment.
     */
    async attachmentHeader(rel: string, n: number): Promise<Buffer> {
      const { resolved } = resolveAttachment(rel);
      let file: fs.promises.FileHandle;
      try {
        file = await fs.promises.open(resolved, "r");
      } catch (err) {
        throw readError(err);
      }
      try {
        const buffer = Buffer.alloc(n);
        const { bytesRead } = await file.read(buffer, 0, n, 0);
        return buffer.subarray(0, bytesRead);
      } catch {
        throw new VaultError("io", "failed to read attachment");
      } finally {
        await file.close();
      }
    },
  };
}

function statOrNull(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/**
 * Lists one level of a vault directory for the file opener's folder
 * browser: subfolders and markdown files, as vault-relative paths (so
 * they plug straight into /file and further /tree calls), folders and
 * files each sorted alphabetically. Dot-prefixed entries are skipped,
 * same as the vault index. Returns null if `relativeDir`
 * escapes the vault, isn't an existing directory, or goes through a link
 * back to a folder it's inside.
 */
function listDirectory(vaultRoot: string, relativeDir: string): DirectoryListing | null {
  const resolved = resolveVaultPath(vaultRoot, relativeDir);
  if (resolved === null) return null;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch {
    return null; // missing, not a directory, or unreadable
  }

  // Built from the requested path, not `resolved` (a realpath), so the
  // listing names entries the way the app asked for them.
  const dir = path.normalize(relativeDir.replace(/^[/\\]+/, "") || ".");
  // The real paths of the listed folder and the folders it's inside, as
  // the vault index walks them: a link back to one of them isn't listed,
  // and a path through one isn't found, the same as /paths. Before, the
  // folder browser could go down A/loop/A/loop/... without end.
  const segments = dir.split(path.sep).filter((s) => s !== "" && s !== ".");
  const ancestors = new Set<string>();
  for (let i = 0; i <= segments.length; i++) {
    const real = resolveVaultPath(vaultRoot, segments.slice(0, i).join("/"));
    if (real === null || ancestors.has(real)) return null;
    ancestors.add(real);
  }
  const folders: string[] = [];
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const rel = path.join(dir, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    // An in-vault symlink is listed like its target, as the index does;
    // resolveVaultPath refuses one leading out or into a
    // dot-folder, and one back to an ancestor is left out (above).
    if (entry.isSymbolicLink()) {
      const target = resolveVaultPath(vaultRoot, rel);
      if (target !== null && ancestors.has(target)) continue;
      const st = target === null ? null : statOrNull(target);
      isDir = st?.isDirectory() ?? false;
      isFile = st?.isFile() ?? false;
    }
    if (isDir) folders.push(rel);
    else if (isFile && entry.name.toLowerCase().endsWith(".md")) files.push(rel);
  }
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });
  return { folders: folders.sort(byName), files: files.sort(byName) };
}
