import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { migrateViewerStateDir, readViewerState } from "./viewer-state";
import { makeVault, type TestVault } from "./test-support";

// The state folder's move from .obsidian-mobile-viewer/ to .mdvju/, including the case Syncthing
// makes: both folders there.

const OLD = ".obsidian-mobile-viewer";
const NEW = ".mdvju";
const NOW = 1_800_000_000_000;

let v: TestVault;
afterEach(() => v?.cleanup());

const state = (home: string) => JSON.stringify({ homePath: home, favourites: [] });

/** Writes `<dir>/state.json` with the given mtime (seconds ago). */
function putState(dir: string, home: string, secondsAgo: number): void {
  const full = v.put(`${dir}/state.json`, state(home));
  const t = NOW / 1000 - secondsAgo;
  fs.utimesSync(full, t, t);
}

const exists = (rel: string) => fs.existsSync(path.join(v.root, rel));
const dotDirs = () => fs.readdirSync(v.root).filter((name) => name.startsWith(".")).sort();

describe("migrateViewerStateDir", () => {
  it("neither folder: does nothing", () => {
    v = makeVault();
    expect(migrateViewerStateDir(v.root, NOW)).toBeNull();
    expect(dotDirs()).toEqual([]);
  });

  it("only .mdvju: does nothing", () => {
    v = makeVault();
    putState(NEW, "New.md", 10);
    expect(migrateViewerStateDir(v.root, NOW)).toBeNull();
    expect(dotDirs()).toEqual([NEW]);
    expect(readViewerState(v.root).homePath).toBe("New.md");
  });

  it("only the old folder: moves it, with everything in it, and only once", () => {
    v = makeVault();
    putState(OLD, "Old.md", 10);
    v.put(`${OLD}/other.txt`, "x");
    expect(migrateViewerStateDir(v.root, NOW)).toMatch(/moved/);
    expect(dotDirs()).toEqual([NEW]);
    expect(v.read(`${NEW}/other.txt`)).toBe("x");
    expect(readViewerState(v.root).homePath).toBe("Old.md");
    expect(migrateViewerStateDir(v.root, NOW)).toBeNull();
  });

  it("both, .mdvju newer: keeps .mdvju, the old folder becomes .bak", () => {
    v = makeVault();
    putState(OLD, "Old.md", 100);
    putState(NEW, "New.md", 10);
    expect(migrateViewerStateDir(v.root, NOW)).toMatch(/kept/);
    expect(dotDirs()).toEqual([NEW, `${OLD}.bak`]);
    expect(readViewerState(v.root).homePath).toBe("New.md");
    expect(JSON.parse(v.read(`${OLD}.bak/state.json`)).homePath).toBe("Old.md");
  });

  it("both, the old one newer: the old one becomes .mdvju, the other .mdvju.bak", () => {
    v = makeVault();
    putState(OLD, "Old.md", 10);
    putState(NEW, "New.md", 100);
    expect(migrateViewerStateDir(v.root, NOW)).toMatch(/newer state\.json, so it is now/);
    expect(dotDirs()).toEqual([NEW, `${NEW}.bak`]);
    expect(readViewerState(v.root).homePath).toBe("Old.md");
    expect(JSON.parse(v.read(`${NEW}.bak/state.json`)).homePath).toBe("New.md");
  });

  it("both, same mtime: keeps .mdvju", () => {
    v = makeVault();
    putState(OLD, "Old.md", 10);
    putState(NEW, "New.md", 10);
    migrateViewerStateDir(v.root, NOW);
    expect(readViewerState(v.root).homePath).toBe("New.md");
    expect(exists(`${OLD}.bak`)).toBe(true);
  });

  it("both, one without a state.json: the one with a state.json wins", () => {
    v = makeVault();
    putState(OLD, "Old.md", 1000);
    fs.mkdirSync(path.join(v.root, NEW));
    migrateViewerStateDir(v.root, NOW);
    expect(readViewerState(v.root).homePath).toBe("Old.md");
    expect(exists(`${NEW}.bak`)).toBe(true);
  });

  it("the old folder synced back again later: never overwrites an earlier .bak", () => {
    v = makeVault();
    putState(NEW, "New.md", 10);
    v.put(`${OLD}.bak/state.json`, state("First backup.md"));
    putState(OLD, "Old again.md", 100);
    migrateViewerStateDir(v.root, NOW);
    expect(dotDirs()).toEqual([NEW, `${OLD}.bak`, `${OLD}.bak-${NOW}`]);
    expect(JSON.parse(v.read(`${OLD}.bak/state.json`)).homePath).toBe("First backup.md");
    expect(JSON.parse(v.read(`${OLD}.bak-${NOW}/state.json`)).homePath).toBe("Old again.md");
    expect(readViewerState(v.root).homePath).toBe("New.md");
  });
});
