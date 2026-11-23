// The backend's runner over the shared source vectors in test/vectors/source/:
// the cases both vault sources must answer alike, kept in one place.
// The app runs the same files against its folder source. test/vectors/README.md ("Source vectors") defines the
// format and every op; this file maps each op onto the HTTP API.
//
// Each case gets a fresh temp vault (makeVault) and createApp() over it,
// indexTtlMs 0. `knownBug` cases run as `it.fails`.

import { describe, expect, it, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { api, makeApp, makeEscapeSymlink, makeVault, type TestVault } from "./support";

const SOURCE = "backend";
const TOKEN = "test-token-123";
const VECTORS_DIR = path.resolve(__dirname, "../test/vectors/source");
const STATE_FILE = path.join(".mdvju", "state.json");

interface Step {
  op: string;
  expected: unknown;
  differs?: Record<string, { expected: unknown; why: string }>;
  [arg: string]: unknown;
}

interface SourceCase {
  id: string;
  name: string;
  knownBug?: string;
  vault: { files: Record<string, string>; folders?: string[]; mtimes?: Record<string, string>; escapeSymlink?: boolean; state?: string };
  readNotes?: boolean;
  steps: Step[];
  differs?: Record<string, { steps: Step[]; why: string }>;
}

function loadCases(): SourceCase[] {
  return fs
    .readdirSync(VECTORS_DIR)
    .sort()
    .flatMap((area) =>
      fs
        .readdirSync(path.join(VECTORS_DIR, area))
        .filter((f) => f.endsWith(".json"))
        .sort()
        .flatMap((f) => {
          const parsed = JSON.parse(fs.readFileSync(path.join(VECTORS_DIR, area, f), "utf8"));
          return Array.isArray(parsed) ? parsed : [parsed];
        }),
    );
}

let v: TestVault | undefined;
afterEach(() => {
  v?.cleanup();
  v = undefined;
});

function setUp(c: SourceCase) {
  v = makeVault(c.vault.files);
  for (const dir of c.vault.folders ?? []) fs.mkdirSync(path.join(v.root, dir), { recursive: true });
  for (const [rel, iso] of Object.entries(c.vault.mtimes ?? {})) {
    const when = new Date(iso);
    fs.utimesSync(path.join(v.root, rel), when, when);
  }
  if (c.vault.escapeSymlink) makeEscapeSymlink(v);
  if (c.vault.state !== undefined) v.put(STATE_FILE, c.vault.state);
  // readNotes: the backend reads every note itself.
  return api(makeApp(v, { authToken: TOKEN, indexTtlMs: 0 }), TOKEN);
}

type Http = ReturnType<typeof api>;
type Res = Awaited<ReturnType<Http["get"]>>;

/** The body of a 200, or `{status}` for anything else. */
function answer(res: Res, body: (b: any) => unknown = (b) => b): unknown {
  return res.status === 200 ? body(res.body) : { status: res.status };
}

const pathBody = (step: Step) => ("path" in step ? { path: step.path } : {});
const query = (step: Step, key: string, name = key): Record<string, string> => (step[key] === undefined ? {} : { [name]: step[key] as string });

interface RecentItem {
  path: string;
  mtimeMs: number;
}

async function recentPage(http: Http, cursor?: string): Promise<{ status: number; results: RecentItem[]; nextCursor: string | null }> {
  const res = await http.get("/recent", cursor === undefined ? {} : { cursor });
  if (res.status === 200) for (const r of res.body.results) expect(typeof r.mtimeMs).toBe("number");
  return { status: res.status, ...res.body };
}

/** The ETag of the note's last `note` read, per path (noteUnchanged compares against it). */
const lastVersion = new Map<string, string>();
afterEach(() => lastVersion.clear());

/** Whether GET /file with this ETag answers 304, not modified. */
async function notModified(http: Http, notePath: unknown, etag: string): Promise<boolean> {
  return (await http.get("/file", { path: notePath as string }).set("If-None-Match", etag)).status === 304;
}

async function checkbox(http: Http, step: Step): Promise<unknown> {
  let baseEtag: string | undefined;
  if (step.base === "loaded") baseEtag = (await http.get("/file", { path: step.path as string })).headers.etag;
  if (step.base === "stale") baseEtag = '"stale"';
  const body: Record<string, unknown> = { path: step.path, line: step.line, checked: step.checked };
  if ("expectedLine" in step) body.expectedLine = step.expectedLine;
  if (baseEtag !== undefined) body.baseEtag = baseEtag;
  const res = await http.post("/file/checkbox", body);
  if (res.status !== 200) return { status: res.status };
  return { baseMatched: res.body.baseMatched, etagIsCurrent: await notModified(http, step.path, res.body.etag) };
}

async function run(http: Http, step: Step): Promise<unknown> {
  const root = v!.root;
  switch (step.op) {
    case "note": {
      const res = await http.get("/file", { path: step.path as string });
      if (res.status !== 200) return { status: res.status };
      lastVersion.set(step.path as string, res.headers.etag);
      return res.text;
    }
    case "noteUnchanged":
      return notModified(http, step.path, lastVersion.get(step.path as string)!);
    case "checkbox":
      return checkbox(http, step);
    case "resolve":
      return answer(await http.get("/resolve", { link: step.link as string }), (b) => b.path);
    case "resolveEmbed":
      return answer(await http.get("/resolve-embed", { link: step.link as string, ...query(step, "from") }), (b) => b.path);
    case "tree":
      return answer(await http.get("/tree", query(step, "path")));
    case "treeMentions":
      return JSON.stringify((await http.get("/tree", query(step, "path"))).body).includes(step.text as string);
    case "paths":
      return answer(await http.get("/paths"));
    case "pathsMention":
      return JSON.stringify((await http.get("/paths")).body).includes(step.text as string);
    case "search":
      return answer(await http.get("/search", { q: step.q as string }), (b) => b.results);
    case "searchCount":
      return answer(await http.get("/search", { q: step.q as string }), (b) => b.results.length);
    case "recent": {
      const page = await recentPage(http, step.cursor as string | undefined);
      return page.status === 200 ? { paths: page.results.map((r) => r.path), nextCursor: page.nextCursor } : { status: page.status };
    }
    case "recentPages": {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        const page = await recentPage(http, cursor ?? undefined);
        expect(page.status).toBe(200);
        seen.push(...page.results.map((r) => r.path));
        cursor = page.nextCursor;
        if (cursor === null) break;
      }
      return seen;
    }
    case "recentFirstPage": {
      const first = await recentPage(http);
      const last = first.results[first.results.length - 1];
      return { size: first.results.length, cursorIsLastItem: first.nextCursor === `${last.mtimeMs}|${last.path}` };
    }
    case "recentSecondPage": {
      const first = await recentPage(http);
      const last = first.results[first.results.length - 1];
      const second = await recentPage(http, first.nextCursor!);
      const firstPaths = first.results.map((r) => r.path);
      return {
        disjoint: second.results.length > 0 && !second.results.some((r) => firstPaths.includes(r.path)),
        afterCursor: second.results.every((r) => r.mtimeMs < last.mtimeMs || (r.mtimeMs === last.mtimeMs && r.path > last.path)),
      };
    }
    case "state":
      return answer(await http.get("/state"));
    case "setHome":
      return answer(await http.post("/home", pathBody(step)));
    case "toggleFavourite":
      return answer(await http.post("/favourites/toggle", pathBody(step)));
    case "stored":
      return fs.existsSync(path.join(root, STATE_FILE)) ? JSON.parse(v!.read(STATE_FILE)) : null;
    case "storedRaw":
      return fs.existsSync(path.join(root, STATE_FILE)) ? v!.read(STATE_FILE) : null;
    default:
      throw new Error(`source vector op "${step.op}" isn't implemented by the backend runner`);
  }
}

describe("source vectors (test/vectors/source), backend", () => {
  const cases = loadCases();

  it("loads the shared cases", () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  for (const c of cases) {
    const override = c.differs?.[SOURCE];
    const title = `${c.id}: ${c.name}${override ? ` (differs: ${override.why})` : ""}`;
    (c.knownBug ? it.fails : it)(title, async () => {
      const http = setUp(c);
      for (const [i, step] of (override?.steps ?? c.steps).entries()) {
        const differs = step.differs?.[SOURCE];
        const expected = differs ? differs.expected : step.expected;
        expect(await run(http, step), `step ${i + 1}: ${step.op}`).toEqual(expected);
      }
    });
  }
});
