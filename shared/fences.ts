/**
 * Fenced code blocks, by line -- the one fence rule every note transform
 * uses. It used to be written four times
 * and the copies disagreed: the outline only knew ``` fences, and wikilink
 * and embed rewriting knew none at all.
 *
 * A fence opens with 3+ backticks or tildes, indented up to 3 columns past
 * the enclosing list item's content (so up to 3 at the top level), and
 * closes on a line of at least as many of the same character, with nothing
 * after them, indented no more than 3 past the opening fence; an unclosed
 * fence runs to the end of the text. Without the list-item allowance, a
 * fence inside a list item (indented 4) wasn't seen, and a task inside it
 * could be written. Tabs count as 4 columns.
 *
 * shared/: used by both the backend (the write refuses a task in a fence)
 * and the app, so the two can't disagree. Plain TypeScript, no imports.
 */

const FENCE_RE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
// A list item's marker; the item's content starts after it and its spaces.
const LIST_ITEM_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)/;

function columns(whitespace: string): number {
  let width = 0;
  for (const c of whitespace) width = c === "\t" ? width - (width % 4) + 4 : width + 1;
  return width;
}

/**
 * Fences whose content Obsidian renders as markdown rather than code:
 * native admonitions (```ad-tip), the ones preprocessAdmonitions generates
 * (```admonition-tip) and the video/YouTube blocks. Links and embeds inside
 * them still work; see mapOutsideCode.
 */
const MARKDOWN_FENCE_INFO_RE = /^\s*(ad-|admonition-|video-embed|youtube-embed)/;

/**
 * 0-based indexes of every line inside a fence, the fence lines included.
 * `codeOnly` leaves out fences whose content is markdown (see above).
 */
export function fencedLineIndexes(lines: string[], codeOnly = false): Set<number> {
  const fenced = new Set<number>();
  let fence: string | null = null;
  let fenceIndent = 0;
  let counts = true;
  // The content column of the list item the current line may belong to,
  // or 0 outside a list.
  let listContent = 0;
  lines.forEach((line, i) => {
    const m = FENCE_RE.exec(line);
    if (fence === null) {
      const item = LIST_ITEM_RE.exec(line);
      if (item) {
        listContent = columns(item[1]) + item[2].length + columns(item[3]);
      } else if (line.trim() !== "" && columns(/^[ \t]*/.exec(line)![0]) < listContent) {
        listContent = 0; // a less indented line ends the list item
      }
      if (m && columns(m[1]) <= listContent + 3) {
        fence = m[2];
        fenceIndent = columns(m[1]);
        counts = !(codeOnly && MARKDOWN_FENCE_INFO_RE.test(m[3]));
        if (counts) fenced.add(i);
      }
      return;
    }
    if (counts) fenced.add(i);
    if (
      m &&
      m[2][0] === fence[0] &&
      m[2].length >= fence.length &&
      m[3].trim() === "" &&
      columns(m[1]) <= fenceIndent + 3
    ) {
      fence = null;
    }
  });
  return fenced;
}

const INLINE_CODE_RE = /`[^`\n]*`/g;

/**
 * Applies `transform` to every part of `markdown` that isn't code -- not
 * inside a code fence and not inside an inline `code` span -- and leaves
 * the code untouched. For rewrites that must keep code literal (wikilinks,
 * embeds).
 */
export function mapOutsideCode(markdown: string, transform: (text: string) => string): string {
  const lines = markdown.split("\n");
  const fenced = fencedLineIndexes(lines, true);
  const out: string[] = [];
  let run: string[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    const text = run.join("\n");
    let result = "";
    let last = 0;
    for (const m of text.matchAll(INLINE_CODE_RE)) {
      result += transform(text.slice(last, m.index)) + m[0];
      last = m.index! + m[0].length;
    }
    out.push(result + transform(text.slice(last)));
    run = [];
  };
  lines.forEach((line, i) => {
    if (fenced.has(i)) {
      flushRun();
      out.push(line);
    } else {
      run.push(line);
    }
  });
  flushRun();
  return out.join("\n");
}
