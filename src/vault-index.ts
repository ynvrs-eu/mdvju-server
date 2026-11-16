import * as fs from "fs";
import * as path from "path";
import { extractAliases, hasDisplayableContent } from "../shared/frontmatter";
import type { IndexedNote, VaultSnapshot } from "../shared/vault-snapshot";
import { noteTooLarge } from "../shared/note-size";
import { isNotePath } from "../shared/vault-path-rules";

export type { IndexedNote, VaultSnapshot } from "../shared/vault-snapshot";

/** A snapshot, plus what the backend's /recent needs from each note's content. */
export interface IndexSnapshot extends VaultSnapshot {
  /** The notes with something to show (not empty, not frontmatter-only; shared/frontmatter.ts hasDisplayableContent). */
  displayable: ReadonlySet<string>;
}

/** What the index keeps from a note's content, valid for one mtime. */
interface NoteFacts {
  aliases: string[];
  displayable: boolean;
}

export interface VaultIndex {
  /**
   * The current snapshot. Only the very first call waits for a walk; after
   * that a snapshot older than the TTL is still returned at once, and a
   * background rebuild (shared by all callers) replaces it.
   */
  get(): Promise<IndexSnapshot>;
  /**
   * A snapshot no older than the TTL: the current one if it is, else the
   * rebuild's (one running already is shared). For a lookup that missed in
   * get()'s snapshot, which may be from long before the request (the last
   * one before an idle spell), so a file added since isn't answered as
   * missing (a note's images, added an hour after the last request,
   * all resolved as missing on its first open).
   */
  fresh(): Promise<IndexSnapshot>;
}

// How old a snapshot gets before a request starts a background rebuild. The
// request itself is answered from the old snapshot, so a change shows up
// one rebuild after the first request past this age.
const DEFAULT_TTL_MS = 2000;
// File operations in flight at once during a walk (one per worker): enough
// to overlap NFS round trips, few enough to stay far from the process's fd
// limit.
const MAX_CONCURRENT_IO = 32;

/**
 * One cached index of the vault, instead of a synchronous whole-vault walk
 * on the event loop for every /search, /recent, /resolve and
 * /resolve-embed call (about 170 ms per walk on 30k notes on
 * local disk, with /status blocked meanwhile; slower on NFS).
 *
 * The walk is asynchronous, concurrent requests share one rebuild, and a
 * note's content (its aliases, and whether it has anything to show) is
 * only read again when its mtime changed. Dot-prefixed
 * entries (.git, .obsidian, the app's own state) are left out.
 *
 * Symlinks inside the vault are followed, under the link's own path, the
 * same as GET /file reads through them (/file followed them
 * but search, recent, resolve and tree never listed them). A link that
 * leads out of the vault or into a dot-folder is left out, and a link
 * back to a folder it's already inside isn't walked again, so a loop
 * can't recurse forever.
 */
export function createVaultIndex(vaultRoot: string, ttlMs = DEFAULT_TTL_MS): VaultIndex {
  const root = path.resolve(vaultRoot);
  let realRoot: string | null = null;
  let snapshot: IndexSnapshot | null = null;
  let builtAt = 0;
  let building: Promise<IndexSnapshot> | null = null;
  // path -> what its content says, valid for that mtime.
  const factsCache = new Map<string, NoteFacts & { mtimeMs: number }>();

  async function build(): Promise<IndexSnapshot> {
    const notes: IndexedNote[] = [];
    const displayable = new Set<string>();
    const files: string[] = [];
    const folders: string[] = [];
    const seen = new Set<string>();
    realRoot ??= await fs.promises.realpath(root);

    // The walk is a FIFO of small tasks, one per folder and one per file,
    // run by MAX_CONCURRENT_IO workers. Each task does its file operations
    // one after another, so at most that many are in flight at once. It
    // used to start every entry at once and queue each file operation
    // behind a limiter, which on 30k notes kept ~30k suspended async calls
    // alive: well over 100 MB of heap, 10-30 ms GC pauses early in every
    // build, and ~1.1 s of Array.shift() over a 30k-long waiter queue, all
    // on the event loop, so /status took 40-85 ms mid-build.
    // A queued task is just a closure, and its slot is cleared once taken
    // so a finished task's closure can be collected mid-build.
    const tasks: ((() => Promise<void>) | undefined)[] = [];
    let head = 0;
    let running = 0;
    // Set once a task rejects. Every file operation catches its own errors,
    // so only a programming error gets here; the build rejects and nothing
    // new is started (tasks already in flight just finish).
    let failed = false;

    // The real path of a symlink's target if it's inside the vault and not
    // in a dot-folder, else null.
    async function inVaultTarget(full: string): Promise<string | null> {
      let real: string;
      try {
        real = await fs.promises.realpath(full);
      } catch {
        return null; // broken link
      }
      const rel = path.relative(realRoot!, real);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
      if (rel.split(path.sep).some((segment) => segment.startsWith("."))) return null;
      return real;
    }

    // `ancestors`: the real paths of the folders `dir` is inside.
    async function walk(dir: string, ancestors: ReadonlySet<string>): Promise<void> {
      let realDir: string;
      try {
        realDir = await fs.promises.realpath(dir);
      } catch {
        return;
      }
      if (ancestors.has(realDir)) return;
      const inside = new Set(ancestors).add(realDir);
      if (dir !== root) folders.push(path.relative(root, dir));
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return; // unreadable (permissions, vanished): skip
      }
      for (const entry of entries) {
        if (!entry.name.startsWith(".")) tasks.push(() => visit(dir, entry, inside));
      }
    }

    async function visit(dir: string, entry: fs.Dirent, inside: ReadonlySet<string>): Promise<void> {
      const full = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        const target = await inVaultTarget(full);
        if (target === null) return;
        const st = await fs.promises.stat(target).catch(() => null);
        isDir = st?.isDirectory() ?? false;
        isFile = st?.isFile() ?? false;
      }
      if (isDir) return walk(full, inside);
      if (!isFile) return;
      const rel = path.relative(root, full);
      files.push(rel);
      if (!isNotePath(entry.name)) return;
      let st: fs.Stats;
      try {
        st = await fs.promises.stat(full);
      } catch {
        return; // deleted meanwhile
      }
      const mtimeMs = st.mtimeMs;
      seen.add(rel);
      const facts = await factsOf(full, rel, mtimeMs, st.size);
      notes.push({ path: rel, mtimeMs, aliases: facts.aliases });
      if (facts.displayable) displayable.add(rel);
    }

    tasks.push(() => walk(root, new Set()));
    await new Promise<void>((resolve, reject) => {
      const pump = () => {
        while (!failed && running < MAX_CONCURRENT_IO && head < tasks.length) {
          const task = tasks[head]!;
          tasks[head++] = undefined;
          running++;
          task().then(
            () => {
              running--;
              if (failed) return;
              if (running === 0 && head === tasks.length) resolve();
              else pump();
            },
            (err) => {
              failed = true;
              reject(err);
            },
          );
        }
      };
      pump();
    });
    for (const p of factsCache.keys()) if (!seen.has(p)) factsCache.delete(p);
    // Walk order depends on timing; callers expect a stable order.
    notes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    files.sort();
    folders.sort();
    return { notes, files, folders, displayable };
  }

  async function factsOf(full: string, rel: string, mtimeMs: number, size: number): Promise<NoteFacts> {
    // A note over the cap is never read: opening
    // it says it's too large, so the index still lists it (search, tree,
    // links find it) with no aliases, and counts it as displayable, the
    // same as the folder source does for a note it hasn't read.
    if (noteTooLarge(size)) {
      factsCache.delete(rel);
      return { aliases: [], displayable: true };
    }
    const cached = factsCache.get(rel);
    if (cached && cached.mtimeMs === mtimeMs) return cached;
    let content: string;
    try {
      content = await fs.promises.readFile(full, "utf-8");
    } catch {
      // Unreadable now: no aliases and nothing to show, but not cached, so
      // a read that fails once (EACCES, a transient EIO on NFS) is tried
      // again on the next build instead of hiding the note until it's
      // edited. Also drops what an older mtime cached.
      factsCache.delete(rel);
      return { aliases: [], displayable: false };
    }
    const facts: NoteFacts = { aliases: extractAliases(content), displayable: hasDisplayableContent(content) };
    factsCache.set(rel, { mtimeMs, ...facts });
    return facts;
  }

  function isFresh(): boolean {
    return snapshot !== null && Date.now() - builtAt < ttlMs;
  }

  function rebuild(): Promise<IndexSnapshot> {
    building ??= build()
      .then((s) => {
        snapshot = s;
        builtAt = Date.now();
        return s;
      })
      .finally(() => {
        building = null;
      });
    return building;
  }

  return {
    async get() {
      if (ttlMs === 0) return build(); // no reuse at all: every call walks (tests that edit the vault)
      if (!isFresh() && !building) {
        // Background rebuilds report nothing; the next one tries again.
        rebuild().catch(() => {});
      }
      // Stale-while-revalidate: waiting on a full walk after every idle
      // pause delayed a note's whole link burst by ~0.7 s on 30k notes.
      // Only the cold start waits, and a lookup
      // that missed (fresh()).
      if (snapshot !== null) return snapshot;
      return building!;
    },

    async fresh() {
      if (ttlMs === 0) return build();
      if (isFresh()) return snapshot!;
      return rebuild();
    },
  };
}
