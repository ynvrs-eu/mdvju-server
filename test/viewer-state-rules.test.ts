import { describe, expect, it } from "vitest";
import { parseViewerState, toggleFavourite } from "../shared/viewer-state";

// shared/viewer-state.ts: how a stored viewer state is read. The backend's
// state file (viewer-state.ts readViewerState) and the folder source's
// stored copy (in the app) both go through it.
describe("parseViewerState", () => {
  it("nothing stored yet: the empty defaults", () => {
    expect(parseViewerState(null)).toEqual({ homePath: null, favourites: [] });
  });

  it("reads a stored state as it is", () => {
    const raw = JSON.stringify({ homePath: "Home.md", favourites: ["A.md", "B/C.md"] });
    expect(parseViewerState(raw)).toEqual({ homePath: "Home.md", favourites: ["A.md", "B/C.md"] });
  });

  it("fields of the wrong type read as their defaults, and non-string favourites are dropped", () => {
    expect(parseViewerState(JSON.stringify({ homePath: 3, favourites: "A.md" }))).toEqual({ homePath: null, favourites: [] });
    expect(parseViewerState(JSON.stringify({ favourites: ["A.md", 1, null, { x: 1 }, "B.md"] }))).toEqual({
      homePath: null,
      favourites: ["A.md", "B.md"],
    });
  });

  it("valid JSON that isn't an object reads as the defaults", () => {
    for (const raw of ["null", "42", '"text"', "[]"]) {
      expect(parseViewerState(raw)).toEqual({ homePath: null, favourites: [] });
    }
  });

  it("drops unknown fields", () => {
    expect(parseViewerState(JSON.stringify({ homePath: "H.md", favourites: [], extra: 1 }))).toEqual({ homePath: "H.md", favourites: [] });
  });

  it("throws on a copy that isn't JSON, so a write can't wipe it", () => {
    expect(() => parseViewerState("{not json")).toThrow();
    expect(() => parseViewerState("")).toThrow();
  });
});

describe("toggleFavourite", () => {
  it("adds a path that isn't a favourite, and removes one that is", () => {
    const state = { homePath: "H.md", favourites: ["A.md"] };
    expect(toggleFavourite(state, "B.md")).toEqual({ homePath: "H.md", favourites: ["A.md", "B.md"] });
    expect(toggleFavourite(state, "A.md")).toEqual({ homePath: "H.md", favourites: [] });
  });
});
