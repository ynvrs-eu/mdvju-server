/**
 * The largest note the app opens, from any source: the backend's
 * `GET /file`, a folder, or a file another app hands over.
 * 5 MB: above it the note doesn't open, and the app offers to open it in
 * another app instead (the server's `GET /file/download`). Until 1.0.1 it
 * was 25 MB, from a memory measurement (about 25 MB of app memory per MB
 * of Markdown).
 *
 * Plain TypeScript, importing nothing (see shared/fences.ts).
 */
export const NOTE_MAX_MB = 5;
export const NOTE_MAX_BYTES = NOTE_MAX_MB * 1024 * 1024;

/** What the app says about a note over the cap, whatever its source. */
export const NOTE_TOO_LARGE_MESSAGE = "This note is too large to show.";

/** True when a note of `bytes` is over the cap. */
export function noteTooLarge(bytes: number): boolean {
  return bytes > NOTE_MAX_BYTES;
}
