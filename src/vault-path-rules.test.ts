import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as path from "path";
import { cleanVaultPath, isNotePath, normalizeVaultPath } from "../shared/vault-path-rules";
import { resolveVaultPath } from "./vault-path";
import { makeVault, type TestVault } from "./test-support";

// shared/vault-path-rules.ts, the string half of resolveVaultPath. The app's
// folder source applies the same rule before its native module does its own
// containment check.
const CASES: [input: string, expected: string | null][] = [
  ["Notes/Hello.md", "Notes/Hello.md"],
  ["", ""],
  ["Notes/", "Notes/"],
  ["/etc/passwd", "etc/passwd"],
  ["///Notes/Hello.md", "Notes/Hello.md"],
  ["\\Notes\\Hello.md", "Notes\\Hello.md"],
  ["/\\/Notes", "Notes"],
  ["a..b/c...md", "a..b/c...md"], // dots inside a name are fine
  ["Notes/My Note.md", "Notes/My Note.md"],
  [".git/config", null],
  [".obsidian", null],
  ["Notes/.hidden.md", null],
  ["a/.mdvju/state.json", null],
  ["..", null],
  ["../outside.md", null],
  ["Notes/../../outside.md", null],
  ["Notes/../Hello.md", null], // ".." is refused even when it stays inside
  ["Notes\\..\\Hello.md", null],
  [".", null],
  ["./Notes/Hello.md", null],
  ["Notes/./Hello.md", null],
  ["/../outside.md", null],
];

describe("cleanVaultPath", () => {
  for (const [input, expected] of CASES) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(cleanVaultPath(input)).toBe(expected);
    });
  }

  describe("every path it refuses, resolveVaultPath refuses too", () => {
    let vault: TestVault;
    beforeAll(() => {
      vault = makeVault({ "Notes/Hello.md": "hello", ".git/config": "x", "Notes/.hidden.md": "x" });
    });
    afterAll(() => vault.cleanup());

    for (const [input] of CASES.filter(([, expected]) => expected === null)) {
      it(JSON.stringify(input), () => {
        expect(resolveVaultPath(vault.root, input)).toBeNull();
      });
    }
  });
});

// The same rule with empty segments dropped: what the folder source, the
// shared listLevel and resolveVaultPath all use, so a path means the same
// thing on every source.
const NORMALIZE_CASES: [input: string, expected: string | null][] = [
  ["Notes/Hello.md", "Notes/Hello.md"],
  ["", ""],
  ["/", ""],
  ["///", ""],
  ["Notes/", "Notes"],
  ["Notes//Hello.md", "Notes/Hello.md"],
  ["//Notes///Sub//", "Notes/Sub"],
  ["/etc/passwd", "etc/passwd"],
  ["\\Notes\\Hello.md", "Notes\\Hello.md"], // only "/" separates; "\\" stays in the name
  ["Notes\\\\Hello.md", "Notes\\\\Hello.md"],
  ["Notes/My Note.md", "Notes/My Note.md"],
  ["a..b/c...md", "a..b/c...md"],
  [".git/config", null],
  ["Notes//.hidden.md", null],
  ["Notes/../Hello.md", null],
  ["..", null],
  [".", null],
];

describe("normalizeVaultPath", () => {
  for (const [input, expected] of NORMALIZE_CASES) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(normalizeVaultPath(input)).toBe(expected);
    });
  }

  it("refuses exactly what cleanVaultPath refuses", () => {
    for (const [input] of [...CASES, ...NORMALIZE_CASES]) {
      expect(normalizeVaultPath(input) === null, JSON.stringify(input)).toBe(cleanVaultPath(input) === null);
    }
  });

  it("names the same place as path.resolve on the cleaned path, as the backend had it", () => {
    const root = path.resolve("/vault");
    for (const [input] of [...CASES, ...NORMALIZE_CASES]) {
      const cleaned = cleanVaultPath(input);
      if (cleaned === null) continue;
      expect(path.resolve(root, normalizeVaultPath(input)!), JSON.stringify(input)).toBe(path.resolve(root, cleaned));
    }
  });
});

// One "is a note" rule for the backend, the folder source and the app.
describe("isNotePath", () => {
  it.each([
    ["Note.md", true],
    ["A/B/Note.MD", true],
    ["Note.Md", true],
    ["Note.md.txt", false],
    ["Note", false],
    ["pic.png", false],
    ["A.md/pic.png", false],
  ] as const)("%s → %s", (p, expected) => {
    expect(isNotePath(p)).toBe(expected);
  });
});
