/**
 * What counts as a task-list line, and how a tick changes it -- the one
 * rule for the app (which lines render as tappable checkboxes) and the
 * backend (which lines the write may change). There used to be three
 * copies that disagreed: the backend took a bare `- [ ]` and the app
 * didn't, and neither took a CRLF line.
 *
 * A task is `- [ ] text` or `- [x] text` (`X` too), indented by any
 * whitespace, with a space after the box; the text may be empty (`- [ ] `).
 * A bare `- [ ]`, `- [ ]x`, and `*`/`+`/`1.` bullets are not tasks
 * (V-checkboxes-05). A trailing `\r` (a CRLF file split on `\n`) is not
 * part of the text and is kept by a toggle.
 *
 * Plain TypeScript with no imports (see shared/fences.ts).
 */

const TASK_LINE_RE = /^(\s*)- \[([ xX])\] (.*?)(\r?)$/;

export interface TaskLine {
  /** The whitespace before the `-`. */
  indent: string;
  checked: boolean;
  /** Everything after `] `, without a trailing `\r`. */
  text: string;
}

/** The task on this line (one line, no `\n`), or null if it isn't one. */
export function parseTaskLine(line: string): TaskLine | null {
  const m = TASK_LINE_RE.exec(line);
  if (!m) return null;
  return { indent: m[1], checked: m[2] !== " ", text: m[3] };
}

/**
 * The line with only its state character set (`x` or a space), every
 * other byte unchanged, including an `<!-- sp:uuid -->` marker and a
 * trailing `\r`. Null if the line isn't a task.
 */
export function setTaskChecked(line: string, checked: boolean): string | null {
  const m = TASK_LINE_RE.exec(line);
  if (!m) return null;
  const at = m[1].length + 3; // past the indent and "- ["
  return line.slice(0, at) + (checked ? "x" : " ") + line.slice(at + 1);
}
