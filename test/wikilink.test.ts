import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  embedPathMatched,
  markdownEmbedPathMatched,
  resolveEmbed,
  resolveFreshIfUnsure,
  resolveMarkdownEmbed,
  resolveWikilink,
  wikilinkPathMatched,
} from "../shared/wikilink";
import { createVaultIndex, type VaultSnapshot } from "../src/vault-index";
import { makeVault, type TestVault } from "./support";

describe("resolveWikilink (synthetic fixture vault)", () => {
  let vault: TestVault;
  let snap: VaultSnapshot;

  beforeAll(async () => {
    vault = makeVault();
    const write = (relPath: string, content: string) => vault.put(relPath, content);

    write("Notes/My Daily Routine.md", "# Daily Routine\ncontent");
    write("Notes/Sub/Other Note.md", "# Other\ncontent");

    // ambiguous basename: two files named "index.md" at different depths
    write("References/hardware/index.md", "hardware index");
    write("References/sociology/index.md", "sociology index"); // same depth, tiebreak by name
    write("Root/index.md", "root index"); // shallowest -- should win

    // alias-only resolution: no file literally named SUP.md or "paddle board.md"
    write(
      "Gear/Stand-Up-Paddleboard.md",
      ["---", "aliases:", "  - SUP", "  - paddle board", "---", "body"].join("\n"),
    );

    // single-string alias form
    write("Gear/Mini PC.md", ["---", "aliases: miniOne", "---", "body"].join("\n"));

    snap = await createVaultIndex(vault.root).get();
  });

  afterAll(() => {
    vault.cleanup();
  });

  it("resolves an exact basename match", () => {
    expect(resolveWikilink("My Daily Routine", snap)).toBe("Notes/My Daily Routine.md");
  });

  it("normalizes spaces/-/_ as equivalent, case-insensitively", () => {
    expect(resolveWikilink("my-daily_routine", snap)).toBe("Notes/My Daily Routine.md");
    expect(resolveWikilink("MY DAILY ROUTINE", snap)).toBe("Notes/My Daily Routine.md");
  });

  it("ignores a trailing .md in the link text", () => {
    expect(resolveWikilink("Other Note.md", snap)).toBe("Notes/Sub/Other Note.md");
  });

  it("resolves a full path link text via exact path match", () => {
    expect(resolveWikilink("References/hardware/index", snap)).toBe(
      "References/hardware/index.md",
    );
  });

  it("falls back to the shortest distinguishing path for an ambiguous basename", () => {
    expect(resolveWikilink("index", snap)).toBe("Root/index.md");
  });

  it("resolves via frontmatter aliases (list form) when no filename matches", () => {
    expect(resolveWikilink("SUP", snap)).toBe("Gear/Stand-Up-Paddleboard.md");
    expect(resolveWikilink("paddle-board", snap)).toBe("Gear/Stand-Up-Paddleboard.md");
  });

  it("resolves via frontmatter aliases (single-scalar form)", () => {
    expect(resolveWikilink("miniOne", snap)).toBe("Gear/Mini PC.md");
  });

  it("returns null when nothing matches", () => {
    expect(resolveWikilink("Totally Nonexistent Note", snap)).toBeNull();
  });

  it("prefers a direct filename match over an alias match", () => {
    // "Mini PC" is the real filename; alias "miniOne" should not shadow it.
    expect(resolveWikilink("Mini PC", snap)).toBe("Gear/Mini PC.md");
  });
});

describe("the path match rules and resolveFreshIfUnsure", () => {
  it("wikilinkPathMatched: true for the path the link names, or a link with no path; false for a same-name note elsewhere", () => {
    expect(wikilinkPathMatched("Projects/App/design/x/Screenshots", "Projects/App/design/x/Screenshots.md")).toBe(true);
    expect(wikilinkPathMatched("Projects/my_app/design/x/screenshots.md#Top|alias", "Projects/My App/design/x/Screenshots.md")).toBe(true);
    expect(wikilinkPathMatched("Projects/App/design/x/Screenshots", "Projects/App/store/Screenshots.md")).toBe(false);
    expect(wikilinkPathMatched("Screenshots", "Projects/App/store/Screenshots.md")).toBe(true);
  });

  it("embedPathMatched: the file by its full path, or the note the embed names, or no path", () => {
    expect(embedPathMatched("design/x/Shot.PNG|300", "design/x/shot.png")).toBe(true);
    expect(embedPathMatched("design/x/Note#Top", "design/x/Note.md")).toBe(true);
    expect(embedPathMatched("design/x/shot.png", "_attachments/shot.png")).toBe(false);
    expect(embedPathMatched("shot.png", "_attachments/shot.png")).toBe(true);
  });

  it("markdownEmbedPathMatched: only the target relative to the note's folder, or a target with one candidate", () => {
    expect(markdownEmbedPathMatched("img/a.png", "d/Note.md", "d/img/A.png")).toBe(true);
    expect(markdownEmbedPathMatched("img/a.png", "d/Note.md", "img/a.png")).toBe(false);
    expect(markdownEmbedPathMatched("img/a.png", "d/Note.md", "x/img/a.png")).toBe(false);
    expect(markdownEmbedPathMatched("/img/a.png", "d/Note.md", "img/a.png")).toBe(true);
    expect(markdownEmbedPathMatched("../img/a.png", "d/e/Note.md", "d/img/a.png")).toBe(true);
  });

  it("resolveFreshIfUnsure: fresh only on a miss or an unmatched hit; a failed rebuild keeps the hit, a miss passes it on", async () => {
    const find = (s: string) => (s === "none" ? null : s);
    let freshCalls = 0;
    const fresh = (s: string | null) => async () => {
      freshCalls++;
      return s;
    };
    expect(await resolveFreshIfUnsure(find, () => true, async () => "a.md", fresh("b.md"))).toBe("a.md");
    expect(freshCalls).toBe(0);
    expect(await resolveFreshIfUnsure(find, () => false, async () => "a.md", fresh("b.md"))).toBe("b.md");
    expect(await resolveFreshIfUnsure(find, () => false, async () => "a.md", fresh("none"))).toBe("a.md");
    expect(await resolveFreshIfUnsure(find, () => false, async () => "a.md", fresh(null))).toBe("a.md");
    expect(await resolveFreshIfUnsure(find, () => true, async () => "none", fresh("b.md"))).toBe("b.md");
    const boom = async () => {
      throw new Error("boom");
    };
    expect(await resolveFreshIfUnsure(find, () => false, async () => "a.md", boom)).toBe("a.md");
    await expect(resolveFreshIfUnsure(find, () => false, async () => "none", boom)).rejects.toThrow("boom");
  });
});

describe("resolveEmbed (synthetic fixture vault)", () => {
  let vault: TestVault;
  let snap: VaultSnapshot;

  beforeAll(async () => {
    vault = makeVault();
    const write = (relPath: string, content: string) => vault.put(relPath, content);

    write("_attachments/mobility-cat-cow.gif", "fake gif bytes");
    write("_attachments/Sub/photo.png", "fake png bytes");
    // same basename, different extension -- must not be conflated
    write("_attachments/dup.png", "png bytes");
    write("_attachments/Other/dup.jpg", "jpg bytes");
    // a markdown note, to prove embeds can resolve non-.md targets fine
    // alongside .md ones without special-casing
    write("Notes/plan.md", "# Plan");

    snap = await createVaultIndex(vault.root).get();
  });

  afterAll(() => {
    vault.cleanup();
  });

  it("resolves an exact basename match, extension included", () => {
    expect(resolveEmbed("mobility-cat-cow.gif", snap)).toBe("_attachments/mobility-cat-cow.gif");
  });

  // The suffixes weren't stripped, so a sized embed never resolved.
  it("strips a |width or #suffix before matching", () => {
    expect(resolveEmbed("mobility-cat-cow.gif|220", snap)).toBe("_attachments/mobility-cat-cow.gif");
    expect(resolveEmbed("mobility-cat-cow.gif#frame", snap)).toBe("_attachments/mobility-cat-cow.gif");
  });

  it("resolves a nested basename match", () => {
    expect(resolveEmbed("photo.png", snap)).toBe("_attachments/Sub/photo.png");
  });

  it("does not conflate files sharing a basename but differing by extension", () => {
    expect(resolveEmbed("dup.png", snap)).toBe("_attachments/dup.png");
    expect(resolveEmbed("dup.jpg", snap)).toBe("_attachments/Other/dup.jpg");
  });

  it("resolves a full path link text via exact path match", () => {
    expect(resolveEmbed("_attachments/Sub/photo.png", snap)).toBe("_attachments/Sub/photo.png");
  });

  it("also resolves markdown files (embeds aren't restricted to attachments)", () => {
    expect(resolveEmbed("plan.md", snap)).toBe("Notes/plan.md");
  });

  // A target that names no file falls back to the wikilink rules, so
  // `![[plan]]`, `![[plan#Heading]]` and `![[plan#^block]]` name the note, as `[[plan]]` does.
  it("resolves a note by its name without .md, with a #heading or #^block, as a wikilink does", () => {
    expect(resolveEmbed("plan", snap)).toBe("Notes/plan.md");
    expect(resolveEmbed("Plan#Heading", snap)).toBe("Notes/plan.md");
    expect(resolveEmbed("plan#^abc123", snap)).toBe("Notes/plan.md");
    expect(resolveEmbed("Notes/plan", snap)).toBe("Notes/plan.md");
    expect(resolveEmbed("no such note", snap)).toBeNull();
  });

  // A missing attachment never falls back to a note of that name or alias.
  it("a target with an attachment's extension doesn't fall back to a note", () => {
    expect(resolveEmbed("plan.png", snap)).toBeNull();
    expect(resolveEmbed("plan.pdf", snap)).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(resolveEmbed("nonexistent.gif", snap)).toBeNull();
  });

  // Images in a subfolder next to a note with a
  // non-ASCII path, SVGs in the vault-root _attachments/. Every form resolves.
  it("resolves the forms a real note uses: bare, |300, a partial or full path, an SVG", async () => {
    const dir = "Notatki/łąka";
    vault.put(`${dir}/Żółw - przykład.md`, "x");
    vault.put(`${dir}/obrazy/01-zdjęcie-łąki.jpg`, "jpg");
    vault.put("_attachments/mapa-łąki.svg", "<svg/>");
    const s = await createVaultIndex(vault.root, 0).get();
    const jpg = `${dir}/obrazy/01-zdjęcie-łąki.jpg`;
    expect(resolveEmbed("01-zdjęcie-łąki.jpg", s)).toBe(jpg);
    expect(resolveEmbed("01-zdjęcie-łąki.jpg|300", s)).toBe(jpg);
    expect(resolveEmbed("obrazy/01-zdjęcie-łąki.jpg", s)).toBe(jpg);
    expect(resolveEmbed(jpg, s)).toBe(jpg);
    expect(resolveEmbed("mapa-łąki.svg", s)).toBe("_attachments/mapa-łąki.svg");
  });
});

// A standard Markdown image, `![alt](target)`, with a path
// relative to its note. The app sends the target decoded (no %20, no <...>).
describe("resolveMarkdownEmbed (synthetic fixture vault)", () => {
  let vault: TestVault;
  let snap: VaultSnapshot;
  const NOTE = "Notes/Sub/note.md";

  beforeAll(async () => {
    vault = makeVault({
      [NOTE]: "# Note",
      "Notes/Sub/obrazy/picture.jpg": "jpg",
      "Notes/Sub/picture.jpg": "jpg",
      "Notes/Sub/my pic.png": "png",
      "Notes/Sub/diagram.svg": "<svg/>",
      "Notes/Sub/doc.pdf": "%PDF",
      "Notes/shared/pic.png": "png",
      // The same vault path from the root and from the note's folder.
      "attachments/dup.png": "png",
      "Notes/Sub/attachments/dup.png": "png",
      "attachments/only-at-root.png": "png",
      "Elsewhere/deep/far.png": "png",
      "Elsewhere/missing.png": "png",
      "top.png": "png",
      ".obsidian/secret.png": "png",
    });
    snap = await createVaultIndex(vault.root, 0).get();
  });

  afterAll(() => {
    vault.cleanup();
  });

  const r = (target: string, from = NOTE) => resolveMarkdownEmbed(target, from, snap);

  it("resolves a path relative to the note's folder: a subfolder, a bare name, a name with a space", () => {
    expect(r("obrazy/picture.jpg")).toBe("Notes/Sub/obrazy/picture.jpg");
    expect(r("picture.jpg")).toBe("Notes/Sub/picture.jpg");
    expect(r("my pic.png")).toBe("Notes/Sub/my pic.png");
    expect(r("./obrazy/picture.jpg")).toBe("Notes/Sub/obrazy/picture.jpg");
  });

  it("follows ../ inside the vault", () => {
    expect(r("../shared/pic.png")).toBe("Notes/shared/pic.png");
    expect(r("../../top.png")).toBe("top.png");
    expect(r("obrazy/../picture.jpg")).toBe("Notes/Sub/picture.jpg");
  });

  it("matches case-insensitively, the exact case first", () => {
    expect(r("OBRAZY/Picture.JPG")).toBe("Notes/Sub/obrazy/picture.jpg");
  });

  it("SVG and PDF targets resolve the same way", () => {
    expect(r("diagram.svg")).toBe("Notes/Sub/diagram.svg");
    expect(r("./doc.pdf")).toBe("Notes/Sub/doc.pdf");
  });

  it("prefers the note's folder over the vault root, then falls back to the vault-root path", () => {
    expect(r("attachments/dup.png")).toBe("Notes/Sub/attachments/dup.png");
    expect(r("attachments/only-at-root.png")).toBe("attachments/only-at-root.png");
    expect(r("/attachments/dup.png")).toBe("attachments/dup.png");
  });

  it("falls back to the vault-wide match of the path's end, shortest path first", () => {
    expect(r("far.png")).toBe("Elsewhere/deep/far.png");
    expect(r("deep/far.png")).toBe("Elsewhere/deep/far.png");
    expect(r("eep/far.png")).toBeNull(); // whole segments only
  });

  it("an explicit ./ or ../ path is only relative: no fallback", () => {
    expect(r("./missing.png")).toBeNull();
    expect(r("../missing.png")).toBeNull();
    expect(r("missing.png")).toBe("Elsewhere/missing.png");
  });

  it("refuses a path out of the vault, without a fallback to the same name inside it", () => {
    expect(r("../../../top.png")).toBeNull();
    expect(r("../../../../etc/passwd")).toBeNull();
    expect(r("obrazy/../../../../top.png")).toBeNull();
    expect(r("/../top.png")).toBeNull();
  });

  // The index never lists a dot-folder, so the check needs a
  // snapshot that does, or dropping it changes nothing.
  it("refuses a dot segment even when the snapshot lists the file", () => {
    const dotted: VaultSnapshot = {
      notes: [],
      files: ["Notes/.hidden/pic.png", ".hidden/pic.png", "Notes/.env.png", "Notes/a\\.b/x.png"],
      folders: [],
    };
    const d = (target: string) => resolveMarkdownEmbed(target, "Notes/n.md", dotted);
    expect(d(".hidden/pic.png")).toBeNull();
    expect(d("../.hidden/pic.png")).toBeNull();
    expect(d("/.hidden/pic.png")).toBeNull();
    expect(d(".env.png")).toBeNull();
    expect(d("a\\.b/x.png")).toBeNull();
    expect(d("pic.png")).toBeNull();
  });

  it("refuses dot-folders and a bad note path", () => {
    expect(r("../../.obsidian/secret.png")).toBeNull();
    expect(r(".obsidian/secret.png", "x.md")).toBeNull();
    expect(r("picture.jpg", ".obsidian/x.md")).toBeNull();
    expect(r("")).toBeNull();
  });

  it("from a note at the vault root", () => {
    expect(r("top.png", "Root.md")).toBe("top.png");
    expect(r("../top.png", "Root.md")).toBeNull();
    expect(r("obrazy/picture.jpg", "Root.md")).toBe("Notes/Sub/obrazy/picture.jpg");
  });
});
