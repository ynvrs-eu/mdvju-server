import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { toggleCheckboxInContent } from "../shared/checkbox-edit";

// shared/checkbox-edit.ts, the edit behind POST /file/checkbox. The route
// tests (routes-checkbox.test.ts) cover it through HTTP; these pin the
// function itself, which the app's folder source will call directly.
const VECTORS = path.join(__dirname, "..", "test", "vectors", "checkboxes");
const lineOf = (raw: string, line: number) => raw.split("\n")[line - 1] ?? "";

describe("toggleCheckboxInContent", () => {
  it("checks a box, changing only its state character", () => {
    const raw = "# T\n- [ ] a\n  - [ ] <!-- sp:abc --> b\n";
    expect(toggleCheckboxInContent(raw, 3, true, "  - [ ] <!-- sp:abc --> b")).toEqual({
      ok: true,
      content: "# T\n- [ ] a\n  - [x] <!-- sp:abc --> b\n",
    });
  });

  it("unchecks an `X` box", () => {
    expect(toggleCheckboxInContent("- [X] done", 1, false, "- [X] done")).toEqual({ ok: true, content: "- [ ] done" });
  });

  it("setting a box to the state it already has gives the same content", () => {
    expect(toggleCheckboxInContent("- [x] a\n", 1, true, "- [x] a")).toEqual({ ok: true, content: "- [x] a\n" });
  });

  it("keeps a CRLF line's \\r, and the other CRLF lines", () => {
    const raw = "# T\r\n- [ ] a\r\n- [ ] b\r\n";
    expect(toggleCheckboxInContent(raw, 2, true, "- [ ] a\r")).toEqual({ ok: true, content: "# T\r\n- [x] a\r\n- [ ] b\r\n" });
  });

  it("refuses a line that isn't a task: not-a-task", () => {
    expect(toggleCheckboxInContent("# T\n- [ ] a", 1, true, "# T")).toEqual({ ok: false, reason: "not-a-task" });
  });

  it("refuses a bare `- [ ]` with no space after it: not-a-task", () => {
    expect(toggleCheckboxInContent("- [ ]", 1, true, "- [ ]")).toEqual({ ok: false, reason: "not-a-task" });
  });

  it("refuses a line past the end, and line 0: not-a-task", () => {
    expect(toggleCheckboxInContent("- [ ] a", 2, true, "")).toEqual({ ok: false, reason: "not-a-task" });
    expect(toggleCheckboxInContent("- [ ] a", 0, true, "")).toEqual({ ok: false, reason: "not-a-task" });
  });

  it("refuses a task in a ``` or ~~~ fence: in-fence", () => {
    const raw = "```\n- [ ] in backticks\n```\n~~~\n- [ ] in tildes\n~~~\n- [ ] outside";
    expect(toggleCheckboxInContent(raw, 2, true, "- [ ] in backticks")).toEqual({ ok: false, reason: "in-fence" });
    expect(toggleCheckboxInContent(raw, 5, true, "- [ ] in tildes")).toEqual({ ok: false, reason: "in-fence" });
    expect(toggleCheckboxInContent(raw, 7, true, "- [ ] outside")).toEqual({
      ok: true,
      content: "```\n- [ ] in backticks\n```\n~~~\n- [ ] in tildes\n~~~\n- [x] outside",
    });
  });

  it("refuses a task line that differs from expectedLine: line-changed", () => {
    // A line inserted above the target: line 2 is still a task, a different one.
    const raw = "# T\n- [ ] inserted\n- [ ] target";
    expect(toggleCheckboxInContent(raw, 2, true, "- [ ] target")).toEqual({ ok: false, reason: "line-changed" });
    // Same text, other state: the client's copy is stale.
    expect(toggleCheckboxInContent("- [x] a", 1, false, "- [ ] a")).toEqual({ ok: false, reason: "line-changed" });
  });

  it("checks not-a-task before in-fence, and in-fence before line-changed (the route's 409 messages follow this order)", () => {
    expect(toggleCheckboxInContent("```\n# not a task\n```", 2, true, "other")).toEqual({ ok: false, reason: "not-a-task" });
    expect(toggleCheckboxInContent("```\n- [ ] a\n```", 2, true, "other")).toEqual({ ok: false, reason: "in-fence" });
  });

  describe("matches the app's checkboxToggle vectors", () => {
    for (const id of ["V-checkboxes-06", "V-checkboxes-07", "V-checkboxes-13"]) {
      const file = JSON.parse(fs.readFileSync(path.join(VECTORS, `${id}.json`), "utf8"));
      for (const v of (Array.isArray(file) ? file : [file]).filter((c) => c.input.op === "checkboxToggle")) {
        it(`${v.id}: ${v.name}`, () => {
          const { raw, line, checked } = v.input;
          const result = toggleCheckboxInContent(raw, line, checked, lineOf(raw, line));
          // A refusal leaves the note unchanged, as the vector expects.
          expect(result.ok ? result.content : raw).toBe(v.expected);
        });
      }
    }
  });

  describe("refuses exactly the task lines the app's fence vectors show as code", () => {
    const TASK_RE = /^\s*- \[[ xX]\] /;
    for (const id of ["V-checkboxes-10", "V-checkboxes-11", "V-checkboxes-14", "V-checkboxes-16"]) {
      it(id, () => {
        const v = JSON.parse(fs.readFileSync(path.join(VECTORS, `${id}.json`), "utf8"));
        const raw: string = v.input.raw;
        const tappable = new Set<number>(
          v.expected.filter((p: { type: string }) => p.type === "checkbox").map((p: { line: number }) => p.line),
        );
        raw.split("\n").forEach((text, i) => {
          if (!TASK_RE.test(text)) return;
          const result = toggleCheckboxInContent(raw, i + 1, true, text);
          expect(result.ok || result.reason, `line ${i + 1}: ${text}`).toBe(tappable.has(i + 1) ? true : "in-fence");
        });
      });
    }
  });
});
