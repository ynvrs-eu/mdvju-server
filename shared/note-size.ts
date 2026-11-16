/**
 * The largest note the app opens, from any source: the backend's
 * `GET /file`, a folder, or a file another app hands over.
 * Measured on 2026-11-03:
 * the app's memory grows by about 25 MB per MB of Markdown, so a note of
 * NOTE_MAX_MB still opens comfortably on a 4 GB iPhone, with headroom
 * below the size where iOS ends the app.
 *
 * Plain TypeScript, importing nothing (see shared/fences.ts).
 */
export const NOTE_MAX_MB = 25;
export const NOTE_MAX_BYTES = NOTE_MAX_MB * 1024 * 1024;

/** What the app says about a note over the cap, whatever its source. */
export const NOTE_TOO_LARGE_MESSAGE = `This note is larger than ${NOTE_MAX_MB} MB, the most this app opens.`;

/** True when a note of `bytes` is over the cap. */
export function noteTooLarge(bytes: number): boolean {
  return bytes > NOTE_MAX_BYTES;
}
