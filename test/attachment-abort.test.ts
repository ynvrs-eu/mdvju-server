// On a real listening socket: aborting /attachment requests
// mid-stream must not leave the file open. Counts this process's open fds
// through /proc, so Linux only.

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import express from "express";
import * as fs from "fs";
import * as http from "http";
import { AddressInfo } from "net";
import { deriveAttachmentKey } from "../src/server";
import { makeApp, makeVault, type TestVault } from "./support";

const TOKEN = "abort-test-token";
/** The URL credential images use (?token= is refused). */
const KEY = deriveAttachmentKey(TOKEN);
const HAS_PROC_FD = fs.existsSync("/proc/self/fd");

let vault: TestVault;
let server: http.Server;
let port: number;

beforeEach(async () => {
  // Big enough that the response can't finish before the abort.
  vault = makeVault({ "big.gif": Buffer.alloc(32 * 1024 * 1024) });
  server = makeApp(vault, { authToken: TOKEN }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  vault.cleanup();
});

const openFds = () => fs.readdirSync("/proc/self/fd").length;

/**
 * Requests the big attachment and aborts once the first bytes arrive. With
 * `range`, a Range request (206), the way AVPlayer aborts one on every seek.
 */
function abortMidStream(range?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: `/attachment?path=big.gif&key=${KEY}`,
        headers: range ? { Range: range } : {},
        agent: false,
      },
      (res) => {
        const expected = range ? 206 : 200;
        if (res.statusCode !== expected) reject(new Error(`status ${res.statusCode}`));
        res.once("data", () => {
          req.destroy();
          resolve();
        });
      },
    );
    req.on("error", () => {});
  });
}

it.skipIf(!HAS_PROC_FD)("B-attach-05: 20 requests aborted mid-stream leave no files open", async () => {
  await abortMidStream(); // warm up: lazily opened fds (sockets, the loop) aren't leaks
  await new Promise((r) => setTimeout(r, 200));
  const before = openFds();
  for (let i = 0; i < 20; i++) await abortMidStream();
  // Give the server time to see each close.
  await new Promise((r) => setTimeout(r, 500));
  expect(openFds()).toBeLessThanOrEqual(before + 2);
});

it.skipIf(!HAS_PROC_FD)("B-attach-17: 20 Range requests aborted mid-stream leave no files open", async () => {
  await abortMidStream("bytes=0-");
  await new Promise((r) => setTimeout(r, 200));
  const before = openFds();
  for (let i = 0; i < 20; i++) await abortMidStream(i % 2 ? "bytes=0-" : `bytes=${i * 1024 * 1024}-`);
  await new Promise((r) => setTimeout(r, 500));
  expect(openFds()).toBeLessThanOrEqual(before + 2);
});

/** Sends the request and closes the socket at once, before any response. */
function abortBeforeResponse(): Promise<void> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: `/attachment?path=big.gif&key=${KEY}`, agent: false });
    req.on("error", () => {});
    req.on("finish", () => {
      req.destroy();
      resolve();
    });
  });
}

/** Collects the unhandled rejections while `fn` runs, and for a moment after. */
async function unhandledRejectionsDuring(fn: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  return seen;
}

it("B-attach-18: requests closed before the file is open don't crash the server", async () => {
  // In a real server an unhandled rejection ends the process; the test
  // itself must see it (without the fix, only vitest's own
  // guard failed the run, the test passed).
  const seen = await unhandledRejectionsDuring(async () => {
    for (let i = 0; i < 50; i++) await abortBeforeResponse();
  });
  expect(seen).toEqual([]);
  const status = await new Promise<number | undefined>((resolve) => {
    http.get({ host: "127.0.0.1", port, path: `/attachment?path=big.gif&key=${KEY}`, agent: false }, (res) => {
      resolve(res.statusCode);
      res.destroy();
    });
  });
  expect(status).toBe(200);
});

it("B-attach-19: a throw while the headers are set is a JSON 500 and closes the file, not an unhandled rejection", async () => {
  const before = HAS_PROC_FD ? openFds() : 0;
  const type = vi.spyOn(express.response, "type").mockImplementationOnce(() => {
    throw new Error("boom");
  });
  let status: number | undefined;
  let body = "";
  const seen = await unhandledRejectionsDuring(
    () =>
      new Promise<void>((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port, path: `/attachment?path=big.gif&key=${KEY}`, agent: false }, (res) => {
            status = res.statusCode;
            res.on("data", (d: Buffer) => (body += d.toString()));
            res.on("end", resolve);
          })
          .on("error", reject);
      }),
  );
  type.mockRestore();
  expect(seen).toEqual([]);
  expect(status).toBe(500);
  expect(JSON.parse(body)).toEqual({ error: "internal error" });
  if (HAS_PROC_FD) expect(openFds()).toBeLessThanOrEqual(before + 2);
});
