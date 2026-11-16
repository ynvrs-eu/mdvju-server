/**
 * The vault's notes and files at one moment: what the backend's index
 * (src/vault-index.ts) builds from the vault folder, and what the
 * pure lookups (shared/wikilink.ts, shared/vault-queries.ts) read.
 *
 * Plain TypeScript, importing only from shared/ (see shared/fences.ts).
 */

export interface IndexedNote {
  /** Vault-relative path. */
  path: string;
  mtimeMs: number;
  aliases: string[];
}

/** The vault's notes and files at one moment. */
export interface VaultSnapshot {
  notes: IndexedNote[];
  /** Every file (any extension), vault-relative: embed targets. */
  files: string[];
  /** Every folder walked, vault-relative (not the root itself). */
  folders: string[];
}
