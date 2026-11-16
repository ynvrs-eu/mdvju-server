# Test vectors

Portable JSON test cases, shared with the mdvju app: the app runs the same files against its own code, so the server and the app can't drift apart on these rules. Three kinds are here:

- `checkboxes/`: what counts as a task line and how a tick changes it (`shared/tasks.ts`, `shared/checkbox-edit.ts`, `shared/fences.ts`). Runners: `src/checkbox-edit.test.ts`, `src/fences.test.ts`.
- `imagesize/`: an image's size from its first bytes (`shared/image-size.ts`). Runner: `src/image-size.test.ts`.
- `source/`: what a vault source answers over a small vault, over the HTTP API. Runner: `src/source-vectors.test.ts`.

## Layout

```
test/vectors/<module>/V-<module>-NN.json    one case, or an array of cases
test/vectors/source/<area>/B-<area>-NN.json  one source case
```

Read the `.json` files of a module in filename order; a file holds one case object or an array of them. A case:

```json
{ "id": "V-checkboxes-05", "name": "...", "input": { "op": "checkboxToggle", ... }, "expected": ..., "knownBug": "..." }
```

- `id` is unique across all vectors. A file with several cases gives each a letter suffix (`V-checkboxes-05a`, `V-checkboxes-05b`).
- `knownBug` (optional) means `expected` is the **correct** behaviour and today's code gets it wrong. Run these as expected failures: a wrong result passes, and a correct result must turn the run red so the marker gets removed together with the fix. A crash is not an expected failure.
- Strings are exact: `\n`, `\r\n` and trailing whitespace matter.
- **Raw line number**: 1-indexed line in the raw note, splitting on `\n` only (a `\r` stays part of its line).

## checkboxes

- **`checkboxPieces`** `{ raw }` → a list of blocks in document order: `{ "type": "markdown", "content": string }` (a run of lines joined with `\n`) and `{ "type": "checkbox", ... }` (one task line).
- **`checkboxToggle`** `{ raw, line, checked }` → the raw text with only the state character of the task on raw line `line` set (`x` or space); every other byte unchanged. A line that isn't a task → unchanged.
- **`checkboxStripForDiff`** `{ raw }` → the text with every task's box normalised to `[ ]` / `[x]` (an uppercase `X` becomes `x`); everything else unchanged.

## imagesize

- **`imageSize`** `{ fixture, truncate? } | { bytes }` → `{ width, height }` in pixels, or `null`. The image is a file under `test/fixture-vault/` (its first `truncate` bytes, when given), or `bytes`: the concatenation of its parts, each a hex string (spaces ignored) or `{ fill, count }`, the hex byte `fill` `count` times. Formats: PNG (IHDR, which must be the first chunk), GIF87a/89a (the logical screen), WebP (the first chunk: VP8, VP8L or VP8X) and JPEG (the first SOFn frame header; EXIF orientation 5-8, a SHORT in IFD0 of an `Exif` APP1 before it, swaps width and height). Only the first 256 KiB (`IMAGE_HEADER_BYTES`) count: a JPEG frame header past them gives `null`. Anything else, cut off before the size, or a zero width or height → `null`.

The binary fixtures `Attachments/rotated.jpg` (64x32, orientation 6) and `Attachments/anim.gif` (40x24, two frames) are committed test data.

## Source vectors

`source/<area>/B-<area>-NN.json` (areas `resolve`, `tree`, `paths`, `search`, `recent`, `state`, `note`). Each case gets a fresh vault and a fresh server (`createApp()` over a temp vault, `indexTtlMs: 0`). A case:

```json
{ "id": "B-tree-01", "name": "...", "knownBug": "...", "vault": { ... }, "readNotes": true, "steps": [ ... ], "differs": { ... } }
```

- **`vault`**: `files` (`{path: content}`, UTF-8), and optionally `folders` (empty folders to make), `mtimes` (`{path: ISO timestamp}`; a file not named gets the time it was written), `escapeSymlink` (`vault/escape` → a directory outside the vault holding `secret.md` and `pic.png`), `state` (the stored home-and-favourites state, raw: `.mdvju/state.json`).
- **`readNotes`**: for the app's folder source, which only learns a note's aliases by reading it. The server reads notes itself and ignores it.
- **`steps`**: run in order against the same server; each is `{ op, ...args, expected }`, and the result must deep-equal `expected`.
- **`knownBug`**: as above; run as an expected failure.
- **`differs`**: where the app's folder source differs on purpose. `differs.<source>` (`backend` or `folder`) with `why` and either `expected` (on a step: that source's result instead) or `steps` (on the case: that source's steps instead).

A refusal is `{ "status": N }`: the HTTP status.

Ops:

- **`resolve`** `{ link }` → `GET /resolve`'s `path` (string or null). **`resolveEmbed`** `{ link, from? }` → `GET /resolve-embed`'s; `from` (a note path) is sent when given.
- **`tree`** `{ path? }` → `GET /tree`: `{ folders, files }`. No `path` = none sent; `""` is sent as is.
- **`treeMentions`** `{ path, text }` → whether `tree`'s answer, a refusal's body included, contains `text`. **`pathsMention`** `{ text }` → the same for `paths`.
- **`paths`** → `GET /paths`: `{ folders, files }`.
- **`search`** `{ q }` → `GET /search`'s `results`. **`searchCount`** `{ q }` → their number.
- **`recent`** `{ cursor? }` → one `GET /recent` page as `{ paths, nextCursor }`. Every result must have a numeric `mtimeMs`.
- **`recentPages`** → the paths of every page, following `nextCursor` (at most 10 pages).
- **`recentFirstPage`** → `{ size, cursorIsLastItem }`: the first page's length, and whether `nextCursor` is `"<mtimeMs>|<path>"` of its last item.
- **`recentSecondPage`** → `{ disjoint, afterCursor }`: the page after the first is non-empty and shares no path with it, and every item on it is strictly after the first page's last item (older, or the same mtime and a later path).
- **`state`** → `GET /state`. **`setHome`** `{ path? }` → `POST /home`. **`toggleFavourite`** `{ path? }` → `POST /favourites/toggle`. Each answers `{ homePath, favourites }`. `path` is sent as given, any JSON type; left out, none is sent.
- **`note`** `{ path }` → the note's raw text (`GET /file`). **`noteUnchanged`** `{ path }` → whether reading it again with the ETag the last `note` step read answers 304.
- **`checkbox`** `{ path, line, checked, expectedLine?, base? }` → `POST /file/checkbox` as `{ baseMatched, etagIsCurrent }`: `etagIsCurrent` is whether the returned ETag reads as not modified right after. Fields are sent as given (any JSON type; `expectedLine` left out, none is sent). `base`: `"loaded"` sends the ETag of a read just before, `"stale"` one that matches no version, left out none.
- **`stored`** → the stored state, parsed, or null if none is stored. **`storedRaw`** → the same, unparsed.
- **`corruptBackup`**: the app's folder source only.

HTTP auth, missing query parameters and in-vault symlinks are tested in `src/routes-*.test.ts`.
