/**
 * The edit behind a checkbox tap: sets the task on raw
 * line `line` (1-indexed, split on `\n`) to `checked`, changing only its
 * state character. Refused when the line isn't a task, is inside a code
 * block, or isn't byte for byte the `expectedLine` the client loaded (the
 * note changed since). The backend's POST /file/checkbox turns a refusal
 * into a 409.
 *
 * Plain TypeScript, importing only from shared/ (see shared/fences.ts).
 */

import { fencedLineIndexes } from "./fences";
import { setTaskChecked } from "./tasks";

export type CheckboxRefusal = "not-a-task" | "in-fence" | "line-changed";

export type CheckboxEditResult = { ok: true; content: string } | { ok: false; reason: CheckboxRefusal };

export function toggleCheckboxInContent(
  content: string,
  line: number,
  checked: boolean,
  expectedLine: string,
): CheckboxEditResult {
  const lines = content.split("\n");
  const idx = line - 1;
  // Only the state character changes; indentation, an sp-sync marker
  // and the rest of the line stay byte for byte (shared/tasks.ts).
  const toggled = idx < lines.length ? setTaskChecked(lines[idx], checked) : null;
  if (toggled === null) return { ok: false, reason: "not-a-task" };
  // The app never offers a task inside a code block, and
  // the server refuses one too, for an old app or a hand-made request.
  if (fencedLineIndexes(lines).has(idx)) return { ok: false, reason: "in-fence" };
  if (lines[idx] !== expectedLine) return { ok: false, reason: "line-changed" };
  lines[idx] = toggled;
  return { ok: true, content: lines.join("\n") };
}
