import { IMAGE_HEADER_BYTES, imageSize, type ImageSize } from "../shared/image-size";
import type { Vault } from "./vault";

/** The most image sizes kept in memory, so the memo can't grow for as long as the server runs. */
export const SIZE_MEMO_ENTRIES = 10_000;

// The formats imageSize reads; the app shows no other type as an image.
const SIZED = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export interface AttachmentInfo {
  size?: number;
  mtimeMs?: number;
  width?: number;
  height?: number;
}

/**
 * What /resolve-embed adds to a resolved path: the file's
 * size and mtime (the app's cache version), and for an image its size in
 * pixels, read from its header. Sizes are memoised per path while the
 * file's mtime and size stay the same, least recently used out first.
 */
export function createAttachmentInfo(vault: Vault, maxEntries = SIZE_MEMO_ENTRIES) {
  // A Map keeps insertion order: re-inserting on use makes the first key the least recently used.
  const memo = new Map<string, { mtimeMs: number; size: number; dims: ImageSize | null }>();

  async function dims(rel: string, mtimeMs: number, size: number): Promise<ImageSize | null> {
    const hit = memo.get(rel);
    memo.delete(rel);
    let entry = hit && hit.mtimeMs === mtimeMs && hit.size === size ? hit : undefined;
    if (!entry) entry = { mtimeMs, size, dims: imageSize(await vault.attachmentHeader(rel, IMAGE_HEADER_BYTES)) };
    memo.set(rel, entry);
    if (memo.size > maxEntries) memo.delete(memo.keys().next().value!);
    return entry.dims;
  }

  return {
    /** `{}` for a file /attachment doesn't serve, or one that can't be read: the path alone is still an answer. */
    async info(rel: string): Promise<AttachmentInfo> {
      let stat: { size: number; mtimeMs: number };
      try {
        stat = await vault.openAttachment(rel);
      } catch {
        return {};
      }
      const { size, mtimeMs } = stat;
      if (!SIZED.has(rel.slice(rel.lastIndexOf(".")).toLowerCase())) return { size, mtimeMs };
      // A header that can't be read is a size unknown, like one that doesn't parse.
      return { size, mtimeMs, ...(await dims(rel, mtimeMs, size).catch(() => null)) };
    },

    /** How many sizes are memoised (tests). */
    memoSize(): number {
      return memo.size;
    },
  };
}
