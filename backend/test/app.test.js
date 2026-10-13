import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

// Fakes stand in for Postgres, Redis, BullMQ and OpenSearch, so these tests
// run anywhere (including CI) without any services.
const items = [];
const enqueued = [];
const fakes = {
  db: {
    pingWrite: async () => {},
    replicaStatus: async () => ({ in_recovery: true, lag_seconds: "0.2" }),
    read: async () => ({ rows: [...items].reverse() }),
    write: async (_sql, [name]) => {
      const item = { id: items.length + 1, name, created_at: new Date().toISOString() };
      items.push(item);
      return { rows: [item] };
    },
  },
  redis: { ping: async () => "PONG" },
  queue: { enqueueItemCreated: async (item) => enqueued.push(item) },
  search: {
    health: async () => ({ status: "green" }),
    searchItems: async (q) => items.filter((i) => i.name.includes(q)),
  },
};

let server;
let base;

before(async () => {
  server = createApp(fakes).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test("liveness endpoint responds", async () => {
  const res = await fetch(`${base}/api/health/live`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "alive" });
});

test("readiness fails with 503 when the database is down", async () => {
  const original = fakes.db.pingWrite;
  fakes.db.pingWrite = async () => {
    throw new Error("connection refused");
  };
  const res = await fetch(`${base}/api/health/ready`);
  fakes.db.pingWrite = original;
  assert.equal(res.status, 503);
});

test("readiness reports 503 until startup has finished", async () => {
  const app = createApp({ ...fakes, isReady: () => false });
  const srv = app.listen(0);
  await new Promise((r) => srv.once("listening", r));
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/health/ready`);
  srv.close();
  assert.equal(res.status, 503);
});

test("optional services report disabled when not configured", async () => {
  const app = createApp({ db: fakes.db, redis: null, queue: null, search: null });
  const srv = app.listen(0);
  await new Promise((r) => srv.once("listening", r));
  const base2 = `http://127.0.0.1:${srv.address().port}`;
  const redisRes = await fetch(`${base2}/api/health/redis`);
  const created = await fetch(`${base2}/api/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "no queue" }),
  });
  srv.close();
  assert.equal(redisRes.status, 503);
  assert.equal(created.status, 201);
});

test("POST /api/items validates input", async () => {
  const res = await fetch(`${base}/api/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "   " }),
  });
  assert.equal(res.status, 400);
});

test("POST /api/items writes to the primary and enqueues an event", async () => {
  const res = await fetch(`${base}/api/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "first item" }),
  });
  assert.equal(res.status, 201);
  const item = await res.json();
  assert.equal(item.name, "first item");
  assert.equal(enqueued.at(-1).id, item.id);

  const list = await (await fetch(`${base}/api/items`)).json();
  assert.equal(list[0].name, "first item");
});
