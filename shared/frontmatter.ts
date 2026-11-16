/**
 * Where a note's YAML frontmatter is, and what's left to show without it.
 * One rule for the app (what it renders) and the backend (alias lookup,
 * and which notes /recent leaves out as empty). There used to be three:
 * the app and the backend's /recent shared a regex by hand, and the alias
 * reader took any first line starting with `---` (so `----` too).
 *
 * Frontmatter is a `---` line as the very first line, up to the next line
 * that is exactly `---`, with LF or CRLF line endings.
 *
 * Plain TypeScript, importing only from shared/ (see shared/fences.ts).
 */

import { mapOutsideCode } from "./fences";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

/** The text between the `---` lines, or null if the note has no frontmatter. */
export function frontmatterBlock(markdown: string): string | null {
  const m = FRONTMATTER_RE.exec(markdown);
  return m ? m[1] : null;
}

/** The note without its frontmatter: metadata, not content. */
export function stripFrontmatter(markdown: string): string {
  return markdown.replace(FRONTMATTER_RE, "");
}

/**
 * The note without HTML comments (`<!-- ... -->`, such as the `sp:ID`
 * markers obsidian-sp-sync writes into tasks). A comment is never meant to
 * be visible -- except as code: one inside a code fence or inline code is
 * an example, and stays.
 */
export function stripHtmlComments(markdown: string): string {
  return mapOutsideCode(markdown, (text) => text.replace(HTML_COMMENT_RE, ""));
}

/**
 * Whether a note has anything to show once its frontmatter and comments
 * are gone. /recent leaves the others out.
 */
export function hasDisplayableContent(raw: string): boolean {
  return stripHtmlComments(stripFrontmatter(raw)).trim().length > 0;
}

/**
 * Minimal frontmatter `aliases:` extractor.
 *
 * Deliberately not a full YAML parser -- this spike only needs the
 * `aliases` key, in the two forms Obsidian actually writes:
 *
 *   aliases:
 *     - foo
 *     - bar
 *
 *   aliases: [foo, bar]
 *
 *   aliases: foo
 *
 * Anything else in the frontmatter block is ignored.
 */
export function extractAliases(fileContent: string): string[] {
  const frontmatter = frontmatterBlock(fileContent);
  if (frontmatter === null) return [];

  const lines = frontmatter.split("\n");
  const aliasLineIndex = lines.findIndex((l) => /^aliases\s*:/.test(l));
  if (aliasLineIndex === -1) return [];

  const aliasLine = lines[aliasLineIndex];
  const inlineValue = aliasLine.slice(aliasLine.indexOf(":") + 1).trim();

  if (inlineValue.startsWith("[")) {
    // aliases: [foo, bar]
    return inlineValue
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(",")
      .map((s) => stripQuotes(s.trim()))
      .filter((s) => s.length > 0);
  }

  if (inlineValue.length > 0) {
    // aliases: foo   (single scalar value on the same line)
    return [stripQuotes(inlineValue)];
  }

  // Block list form: subsequent "  - foo" lines until indentation ends.
  const aliases: string[] = [];
  for (let i = aliasLineIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^\s*-\s*(.+)\s*$/);
    if (!match) break;
    aliases.push(stripQuotes(match[1].trim()));
  }
  return aliases;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
