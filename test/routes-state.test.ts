// GET /state, POST /home and POST /favourites/toggle. What they answer and
// store (B-state-*) is in the shared source vectors,
// test/vectors/source/state/ (source-vectors.test.ts), run against both
// sources; only the HTTP-only case is here.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { makeApp, makeVault, type TestVault } from "./support";

const TOKEN = "test-token-123";

let v: TestVault;
let app: ReturnType<typeof makeApp>;

beforeEach(() => {
  v = makeVault();
  app = makeApp(v, { authToken: TOKEN });
});

afterEach(() => v.cleanup());

describe("home + favourites state", () => {
  it("rejects unauthenticated requests on all three endpoints", async () => {
    expect((await request(app).get("/state")).status).toBe(401);
    expect((await request(app).post("/home").send({ path: "A.md" })).status).toBe(401);
    expect((await request(app).post("/favourites/toggle").send({ path: "A.md" })).status).toBe(401);
  });
});
