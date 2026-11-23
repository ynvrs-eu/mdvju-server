// Vault-level tests that need to act inside a single call, which the HTTP
// tests in routes-checkbox.test.ts can't do. Real temp folders, no mocks.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { openVault, VaultError } from "../src/vault";
import { makeVault, type TestVault } from "./support";

let tmp: TestVault;
let root: string;

beforeEach(() => {
  tmp = makeVault();
  root = tmp.root;
});

afterEach(() => {
  tmp.cleanup();
});

function conflictOf(fn: () => unknown): VaultError {
  try {
    fn();
  } catch (err) {
    if (err instanceof VaultError) return err;
    throw err;
  }
  throw new Error("expected a VaultError");
}

describe("updateNote: an edit landing between the read and the rename", () => {
  // `edit` runs after the read and before the write, the exact window
  // Syncthing can land in. The test writes the file from inside it.
  it("B-checkbox-17a: an in-place external write in that window gives a conflict, and the external edit survives", () => {
    const full = path.join(root, "Note.md");
    fs.writeFileSync(full, "- [ ] A\n");
    const vault = openVault(root);
    const err = conflictOf(() =>
      vault.updateNote("Note.md", (content) => {
        fs.writeFileSync(full, "- [ ] A\n- [ ] from sync\n");
        return content.replace("[ ]", "[x]");
      }),
    );
    expect(err.kind).toBe("conflict");
    expect(fs.readFileSync(full, "utf-8")).toBe("- [ ] A\n- [ ] from sync\n");
    expect(fs.readdirSync(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("B-checkbox-17b: a rename-replace in that window (how Syncthing applies an edit) gives a conflict too", () => {
    const full = path.join(root, "Note.md");
    fs.writeFileSync(full, "- [ ] A\n");
    const vault = openVault(root);
    const err = conflictOf(() =>
      vault.updateNote("Note.md", (content) => {
        // Same size as the original, so only the inode tells them apart.
        fs.writeFileSync(path.join(root, ".syncthing.Note.md.tmp"), "- [ ] B\n");
        fs.renameSync(path.join(root, ".syncthing.Note.md.tmp"), full);
        return content.replace("[ ]", "[x]");
      }),
    );
    expect(err.kind).toBe("conflict");
    expect(fs.readFileSync(full, "utf-8")).toBe("- [ ] B\n");
  });

  it("an undisturbed edit still writes", () => {
    fs.writeFileSync(path.join(root, "Note.md"), "- [ ] A\n");
    openVault(root).updateNote("Note.md", (content) => content.replace("[ ]", "[x]"));
    expect(fs.readFileSync(path.join(root, "Note.md"), "utf-8")).toBe("- [x] A\n");
  });
});
