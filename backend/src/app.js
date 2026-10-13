import express from "express";
import { log } from "./logger.js";
import { metricsMiddleware, register } from "./metrics.js";

// The app receives its dependencies (db, redis, queue, search) instead of
// importing them, so tests can pass in fakes and run without any services.
// redis/queue/search may be null when that service isn't configured.
export function createApp({ db, redis, queue, search, isReady = () => true }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));
  app.use(metricsMiddleware);

  // One access-log line per request; probe and scrape traffic is skipped to
  // keep the logs readable.
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/health") || req.path === "/metrics") return next();
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      log.info("request", {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Number(process.hrtime.bigint() - start) / 1e6,
      });
    });
    next();
  });

  app.get("/metrics", async (req, res) => {
    res.set("Content-Type", register.contentType);
    res.send(await register.metrics());
  });

  app.get("/api/health", (req, res) => res.json({ status: "ok" }));

  // Liveness: the process is up and serving. Deliberately has no dependency
  // checks, so a database outage doesn't trigger pointless restarts.
  app.get("/api/health/live", (req, res) => res.json({ status: "alive" }));

  // Readiness: startup finished (schema exists) and the primary DB is
  // reachable. Kubernetes stops routing traffic to pods that fail this.
  app.get("/api/health/ready", async (req, res) => {
    if (!isReady()) return res.status(503).json({ status: "starting" });
    try {
      await db.pingWrite();
      res.json({ status: "ready" });
    } catch (err) {
      res.status(503).json({ status: "not-ready", error: err.message });
    }
  });

  app.get("/api/health/db", async (req, res) => {
    try {
      await db.pingWrite();
      const replica = await db.replicaStatus();
      res.json({
        primary: "ok",
        read_target_is_replica: replica.in_recovery,
        replication_lag_seconds: replica.lag_seconds === null ? null : Number(replica.lag_seconds),
      });
    } catch (err) {
      res.status(503).json({ status: "error", error: err.message });
    }
  });

  app.get("/api/health/redis", async (req, res) => {
    if (!redis) return res.status(503).json({ status: "disabled" });
    try {
      await redis.ping();
      res.json({ status: "ok" });
    } catch (err) {
      res.status(503).json({ status: "error", error: err.message });
    }
  });

  app.get("/api/health/search", async (req, res) => {
    if (!search) return res.status(503).json({ status: "disabled" });
    try {
      const health = await search.health();
      res.json({ status: "ok", cluster: health.status });
    } catch (err) {
      res.status(503).json({ status: "error", error: err.message });
    }
  });

  // Plain list: served from the read replica.
  app.get("/api/items", async (req, res) => {
    try {
      const { rows } = await db.read(
        "SELECT id, name, created_at FROM items ORDER BY id DESC LIMIT 50"
      );
      res.json(rows);
    } catch (err) {
      log.error("list items failed", { error: err.message });
      res.status(500).json({ error: "failed to list items" });
    }
  });

  // Write to the primary, then publish an event. The worker indexes the item
  // into OpenSearch asynchronously, so a slow search cluster never slows down
  // the write path.
  app.post("/api/items", async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) return res.status(400).json({ error: "name is required" });
    if (name.length > 200) return res.status(400).json({ error: "name is too long" });
    try {
      const { rows } = await db.write(
        "INSERT INTO items (name) VALUES ($1) RETURNING id, name, created_at",
        [name]
      );
      const item = rows[0];
      queue?.enqueueItemCreated(item).catch((err) =>
        log.error("failed to enqueue item-created", { item_id: item.id, error: err.message })
      );
      res.status(201).json(item);
    } catch (err) {
      log.error("create item failed", { error: err.message });
      res.status(500).json({ error: "failed to create item" });
    }
  });

  app.get("/api/search", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) return res.status(400).json({ error: "q is required" });
    if (!search) return res.status(503).json({ error: "search disabled" });
    try {
      res.json(await search.searchItems(q));
    } catch (err) {
      log.error("search failed", { error: err.message });
      res.status(502).json({ error: "search unavailable" });
    }
  });

  return app;
}
