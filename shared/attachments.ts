/**
 * Which attachments the app shows, by extension.
 *
 * Plain TypeScript, importing only from shared/ (see shared/fences.ts).
 */

// Attachment embeds (![[file.gif]]) are served as raw binary, restricted to
// this allowlist of what the app can show (images, video, PDF) -- unlike
// notes, there's no reason for attachments to become a generic
// arbitrary-file-read path. No .webm: iOS's AVPlayer can't play it.
export const ATTACHMENT_MIME_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
};
