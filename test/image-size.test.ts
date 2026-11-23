import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { imageSize } from "../shared/image-size";

// The backend sends image sizes from /resolve-embed, so it
// runs the app's V-imagesize vectors too (format: test/vectors/README.md ›
// imagesize).
const REPO = path.join(__dirname, "..");
const VECTORS = path.join(REPO, "test", "vectors", "imagesize");

type Part = string | { fill: string; count: number };
interface Case {
  id: string;
  name: string;
  input: { fixture?: string; truncate?: number; bytes?: Part[] };
  expected: unknown;
}

function bytesOf(input: Case["input"]): Buffer {
  if (input.fixture !== undefined) {
    return fs.readFileSync(path.join(REPO, "test", "fixture-vault", input.fixture)).subarray(0, input.truncate);
  }
  return Buffer.concat(
    input.bytes!.map((p) => (typeof p === "string" ? Buffer.from(p.replace(/ /g, ""), "hex") : Buffer.alloc(p.count, Buffer.from(p.fill, "hex")))),
  );
}

describe("imageSize matches the app's imagesize vectors", () => {
  const cases: Case[] = fs
    .readdirSync(VECTORS)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .flatMap((f) => [JSON.parse(fs.readFileSync(path.join(VECTORS, f), "utf8"))].flat());
  it("has vectors", () => expect(cases.length).toBeGreaterThan(0));
  for (const c of cases) {
    it(`${c.id}: ${c.name}`, () => expect(imageSize(bytesOf(c.input))).toEqual(c.expected));
  }
});
