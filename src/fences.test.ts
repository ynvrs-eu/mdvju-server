import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fencedLineIndexes } from "../shared/fences";

// Same rules as the app: checked against the app's own fence vectors. Every
// task line the app renders as a checkbox must be outside a fence here, and
// every other task-shaped line inside one.
const VECTORS = path.join(__dirname, "..", "test", "vectors", "checkboxes");
const TASK_RE = /^\s*- \[[ xX]\] /;

describe("fencedLineIndexes matches the app's checkbox vectors", () => {
  for (const id of ["V-checkboxes-10", "V-checkboxes-11", "V-checkboxes-14", "V-checkboxes-16"]) {
    it(id, () => {
      const v = JSON.parse(fs.readFileSync(path.join(VECTORS, `${id}.json`), "utf8"));
      const lines: string[] = v.input.raw.split("\n");
      const tappable = new Set<number>(
        v.expected.filter((p: { type: string }) => p.type === "checkbox").map((p: { line: number }) => p.line - 1),
      );
      const fenced = fencedLineIndexes(lines);
      lines.forEach((line, i) => {
        if (!TASK_RE.test(line)) return;
        expect(fenced.has(i), `line ${i + 1}: ${line}`).toBe(!tappable.has(i));
      });
    });
  }
});
