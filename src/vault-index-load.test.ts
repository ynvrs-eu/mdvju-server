// On a real filesystem and a real socket: a cold index build
// over a 30k-note vault must not block the event loop. /status answers
// while the first /search is still building the index.

import { afterAll, beforeAll, expect, it } from "vitest";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { AddressInfo } from "net";
import { makeApp, makeVault, type TestVault } from "./test-support";

const TOKEN = "load-test-token";
const NOTES = 30_000;

let vault: TestVault;
let root: string;
let server: http.Server;
let port: number;

beforeAll(async () => {
  vault = makeVault();
  root = vault.root;
  for (let d = 0; d < NOTES / 100; d++) {
    const dir = path.join(root, `Folder ${d}`);
    fs.mkdirSync(dir);
    for (let n = 0; n < 100; n++) {
      fs.writeFileSync(path.join(dir, `Note ${d}-${n}.md`), n % 10 === 0 ? `---\naliases: [alias ${d}-${n}]\n---\nbody\n` : "body\n");
    }
  }
  server = makeApp(vault, { authToken: TOKEN }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  port = (server.address() as AddressInfo).port;
}, 120_000);

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  vault.cleanup();
});

function get(urlPath: string): Promise<{ status: number; body: string; ms: number }> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: urlPath, headers: { Authorization: `Bearer ${TOKEN}` } }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, ms: performance.now() - started }));
      })
      .on("error", reject);
  });
}

it("B-index-01: /status answers during a cold index build of 30k notes", async () => {
  let searchDone = false;
  const search = get("/search?q=note%20299-99").then((r) => {
    searchDone = true;
    return r;
  });
  // Let the build get going, then ask for /status a few times.
  await new Promise((r) => setTimeout(r, 20));
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push(await get("/status"));
  const statusDuringBuild = searchDone === false;

  const found = await search;
  expect(found.status).toBe(200);
  expect(JSON.parse(found.body).results).toContain(path.join("Folder 299", "Note 299-99.md"));
  expect(statusDuringBuild).toBe(true);
  for (const s of statuses) expect(s.ms).toBeLessThan(100);

  // A link to an alias resolves from the same index.
  const alias = JSON.parse((await get("/resolve?link=alias%20123-40")).body);
  expect(alias.path).toBe(path.join("Folder 123", "Note 123-40.md"));
}, 120_000);

// Past the TTL, every request waited for a full walk
// again (~0.7 s on 30k notes). Now a stale snapshot answers at once while a
// rebuild runs behind it.
it("B-index-02: after the snapshot goes stale, a request is answered at once, and the rebuild picks up a new note", async () => {
  await get("/search?q=note%201-1"); // warm
  await new Promise((r) => setTimeout(r, 2100)); // past the 2 s TTL
  fs.writeFileSync(path.join(root, "Folder 0", "Brand New.md"), "body\n");
  const stale = await get("/search?q=brand%20new");
  expect(stale.ms).toBeLessThan(100);
  expect(JSON.parse(stale.body).results).toEqual([]); // the old snapshot
  // The background rebuild lands; then the note is there.
  let results: string[] = [];
  for (let i = 0; i < 100 && results.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 100));
    results = JSON.parse((await get("/search?q=brand%20new")).body).results;
  }
  expect(results).toEqual([path.join("Folder 0", "Brand New.md")]);
}, 60_000);
