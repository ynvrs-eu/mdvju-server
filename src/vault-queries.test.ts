import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { listLevel } from "../shared/vault-queries";
import type { VaultSnapshot } from "../shared/vault-snapshot";
import { createVaultIndex } from "./vault-index";
import { openVault, VaultError } from "./vault";
import { makeEscapeSymlink, makeVault, type TestVault } from "./test-support";

// shared/vault-queries.ts listLevel: one folder level from a snapshot, for
// the app's folder source. The backend's /tree keeps reading the directory
// live; listLevel must list the same thing from the index.

const FIXTURE_VAULT = path.join(__dirname, "..", "test", "fixture-vault");

/** What GET /tree answers for `dir`: the listing, or the VaultError kind. */
function treeOf(root: string, dir: string) {
  try {
    return openVault(root).listDir(dir);
  } catch (err) {
    if (err instanceof VaultError) return err.kind;
    throw err;
  }
}

/** listLevel's answer in the same terms: null is what /tree refuses (400 or 404). */
function levelOf(snap: VaultSnapshot, dir: string) {
  return listLevel(snap, dir) ?? "refused";
}

function expectSameAsTree(root: string, snap: VaultSnapshot, dir: string) {
  const tree = treeOf(root, dir);
  if (typeof tree === "string") expect(levelOf(snap, dir), `${dir}: /tree says ${tree}`).toBe("refused");
  else expect(levelOf(snap, dir), dir).toEqual(tree);
}

describe("listLevel", () => {
  describe("lists what /tree lists, over the fixture vault", () => {
    let snap: VaultSnapshot;
    beforeAll(async () => {
      snap = await createVaultIndex(FIXTURE_VAULT, 0).get();
    });

    it("the root, and every folder in the snapshot", () => {
      expect(snap.folders.length).toBeGreaterThan(0);
      for (const dir of ["", ...snap.folders]) expectSameAsTree(FIXTURE_VAULT, snap, dir);
    });

    it("the same folder written with a leading slash, a trailing slash or a doubled slash", () => {
      for (const dir of ["/", "/Projects", "Projects/", "Projects//Alpha", "//Projects/Alpha/"]) {
        expectSameAsTree(FIXTURE_VAULT, snap, dir);
      }
    });

    it("refuses what /tree refuses: a dot segment, `..`, a missing folder, a note", () => {
      const note = snap.notes[0].path;
      for (const dir of [".obsidian", "Projects/../Diary", "..", "Missing", "Projects/Missing", note]) {
        expect(listLevel(snap, dir), dir).toBeNull();
        expectSameAsTree(FIXTURE_VAULT, snap, dir);
      }
    });
  });

  describe("lists what /tree lists, over a vault with symlinks, dot entries and mixed case", () => {
    let vault: TestVault;
    let snap: VaultSnapshot;
    beforeAll(async () => {
      vault = makeVault({
        "b.md": "b",
        "A.md": "a",
        "c.MD": "upper-case extension",
        "image.png": "not a note",
        "notes.txt": "not a note",
        ".hidden.md": "dot file",
        ".obsidian/app.json": "{}",
        "Zeta/z.md": "z",
        "alpha/Beta/deep.md": "deep",
        "alpha/x.md": "x",
        "alpha/.trash/old.md": "dot folder",
        "Empty/.keep": "only a dot file",
      });
      fs.mkdirSync(path.join(vault.root, "Bare"));
      fs.symlinkSync(path.join(vault.root, "alpha", "Beta"), path.join(vault.root, "linked"), "dir");
      fs.symlinkSync(path.join(vault.root, "alpha", "x.md"), path.join(vault.root, "Zeta", "x-link.md"));
      makeEscapeSymlink(vault);
      snap = await createVaultIndex(vault.root, 0).get();
    });
    afterAll(() => vault.cleanup());

    it("the root, and every folder in the snapshot", () => {
      for (const dir of ["", ...snap.folders]) expectSameAsTree(vault.root, snap, dir);
    });

    it("pins the root listing: case-insensitive name order, notes only, no dot entries, the in-vault link, not the escape", () => {
      expect(listLevel(snap, "")).toEqual({
        folders: ["alpha", "Bare", "Empty", "linked", "Zeta"],
        files: ["A.md", "b.md", "c.MD"],
      });
      expect(listLevel(snap, "linked")).toEqual({ folders: [], files: ["linked/deep.md"] });
      expect(listLevel(snap, "Zeta")).toEqual({ folders: [], files: ["Zeta/x-link.md", "Zeta/z.md"] });
      expect(listLevel(snap, "Empty")).toEqual({ folders: [], files: [] });
    });

    it("refuses the escape symlink and dot folders, as /tree does", () => {
      for (const dir of ["escape", "alpha/.trash", ".obsidian"]) expectSameAsTree(vault.root, snap, dir);
      expect(listLevel(snap, "escape")).toBeNull();
    });
  });

  it("works from a snapshot alone, with no folder on disk", () => {
    const snap: VaultSnapshot = {
      notes: [
        { path: "Top.md", mtimeMs: 1, aliases: [] },
        { path: "Dir/one.md", mtimeMs: 1, aliases: [] },
        { path: "Dir/Sub/two.md", mtimeMs: 1, aliases: [] },
      ],
      files: ["Top.md", "Dir/one.md", "Dir/Sub/two.md", "Dir/pic.png"],
      folders: ["Dir", "Dir/Sub"],
    };
    expect(listLevel(snap, "")).toEqual({ folders: ["Dir"], files: ["Top.md"] });
    expect(listLevel(snap, "Dir")).toEqual({ folders: ["Dir/Sub"], files: ["Dir/one.md"] });
    expect(listLevel(snap, "Dir/Sub")).toEqual({ folders: [], files: ["Dir/Sub/two.md"] });
    expect(listLevel(snap, "dir")).toBeNull(); // folder names are case-sensitive, as on the server's disk
    expect(listLevel(snap, "Nope")).toBeNull();
  });
});
