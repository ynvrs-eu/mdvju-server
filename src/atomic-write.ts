import * as fs from "fs";
import * as path from "path";

// The temp file's name, `.<note name>.<pid>.<ms timestamp>.tmp`: written
// by writeFileAtomic, recognised by sweepStaleTempFiles. Defined together
// so the two can't drift.
function tempPathFor(target: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
}
const ATOMIC_TEMP_RE = /^\..+\.\d+\.\d+\.tmp$/;

/**
 * Replaces a file's content atomically: writes a hidden temp file next to
 * it, then renames it over the target, so a reader (sync client, Obsidian)
 * sees either the old or the new content, never a half-written file.
 * The temp file gets the target's permission bits,
 * since vault notes may be group-writable and a fresh
 * file would otherwise get the umask's 0644. It also gets the target's
 * group: a fresh file takes this process's primary group, so a host run
 * as a user whose primary group isn't the vault's took group-write away from
 * every ticked note. If this process can't give the temp file
 * that group (it isn't a member), the write is refused rather than
 * changing the group. The owner still becomes this process's user, since
 * only root can keep it. Throws on failure, after removing the temp file;
 * the target is untouched in that case.
 *
 * `unchangedSince`, when given, is the target's stat from before the
 * caller read it. Just before the rename the target is stat'ed again, and
 * if its inode, size or mtime differ, something else wrote it in between
 * (Syncthing applying a remote edit, say): the temp file is removed and a
 * `ConflictError` thrown, so that edit isn't silently overwritten and then
 * spread by sync without a conflict copy. A writer landing
 * between this re-check and the rename itself can still be lost; the
 * window is a single syscall wide.
 *
 * An existing target must be writable by this process first: a rename
 * only needs write access to the folder, so without the check it would
 * replace a read-only note that a plain write refuses, and hand the
 * note's ownership to this process's user.
 */
export class ConflictError extends Error {}

/** The temp file couldn't be given the note's group (this process isn't in it). */
export class GroupError extends Error {
  constructor(readonly gid: number) {
    super(`can't keep the note's group ${gid}: the backend's user isn't a member`);
  }
}

export function writeFileAtomic(target: string, content: string, unchangedSince?: fs.Stats): void {
  let st: fs.Stats | undefined;
  try {
    st = fs.statSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (st) fs.accessSync(target, fs.constants.W_OK);
  const tmp = tempPathFor(target);
  try {
    // fsync before the rename, so a crash right after it can't leave the
    // note renamed but empty.
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, content, "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (st) {
      try {
        fs.chownSync(tmp, -1, st.gid);
      } catch {
        throw new GroupError(st.gid);
      }
      fs.chmodSync(tmp, st.mode & 0o7777);
    }
    if (unchangedSince && !sameFileVersion(unchangedSince, fs.statSync(target))) {
      throw new ConflictError(`${target} changed while it was being written`);
    }
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  // fsync the folder too, so the rename itself survives a crash on a local
  // disk. Best effort: some filesystems refuse fsync on a directory.
  try {
    const dirFd = fs.openSync(path.dirname(target), "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // The write itself succeeded.
  }
}

function sameFileVersion(a: fs.Stats, b: fs.Stats): boolean {
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

const STALE_TEMP_AGE_MS = 60_000;

/**
 * Deletes temp files left by a writeFileAtomic() that died between writing
 * the temp file and renaming it. Runs once at
 * startup. Only files matching the exact temp-name pattern and older than a
 * minute are removed, so a write in flight in another process is safe.
 * Doesn't follow symlinks or descend into .git. Returns the removed paths.
 */
export function sweepStaleTempFiles(vaultRoot: string, nowMs = Date.now()): string[] {
  const removed: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== ".git") walk(full);
      } else if (e.isFile() && ATOMIC_TEMP_RE.test(e.name)) {
        try {
          if (nowMs - fs.statSync(full).mtimeMs < STALE_TEMP_AGE_MS) continue;
          fs.rmSync(full);
          removed.push(full);
        } catch {
          // Gone already, or not ours to remove: leave it.
        }
      }
    }
  };
  walk(path.resolve(vaultRoot));
  return removed;
}
