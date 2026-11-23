// On SIGTERM the server stops taking
// connections, lets the responses in flight finish, then exits 0. Runs
// src/server.ts as a process, as the container does.

import { spawn } from "child_process";
import * as http from "http";
import * as path from "path";
import { expect, it } from "vitest";
import { deriveAttachmentKey } from "../src/server";
import { makeVault } from "./support";

const TOKEN = "shutdown-test-token";
const SIZE = 32 * 1024 * 1024;

it("B-shutdown-01: on SIGTERM a response in flight is sent in full, then the server exits 0", async () => {
  const v = makeVault({ "big.gif": Buffer.alloc(SIZE, 1) });
  const child = spawn(path.join(__dirname, "..", "node_modules", ".bin", "ts-node"), ["--transpile-only", "src/server.ts"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, VAULT_ROOT: v.root, SECRETS_DIR: v.secrets, AUTH_TOKEN: TOKEN, PORT: "0", PUBLIC_URL: "https://viewer.example" },
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let text = "";
      const timer = setTimeout(() => reject(new Error(`no start: ${text}`)), 20_000);
      child.stdout.on("data", (d: Buffer) => {
        text += d.toString();
        const m = /listening on :(\d+)/.exec(text);
        if (m && Number(m[1]) > 0) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
    });
    const received = await new Promise<number>((resolve, reject) => {
      const url = `http://127.0.0.1:${port}/attachment?path=big.gif&key=${deriveAttachmentKey(TOKEN)}`;
      http
        .get(url, { agent: false }, (res) => {
          let bytes = 0;
          res.on("data", (chunk: Buffer) => (bytes += chunk.length));
          // The first bytes are in: stop reading, so most of the file is
          // still to be sent when the signal arrives.
          res.once("data", () => {
            res.pause();
            child.kill("SIGTERM");
            setTimeout(() => res.resume(), 300);
          });
          res.on("close", () => resolve(bytes));
        })
        .on("error", reject);
    });
    expect(received).toBe(SIZE);
    expect(await exited).toBe(0);
  } finally {
    child.kill("SIGKILL");
    v.cleanup();
  }
}, 60_000);
