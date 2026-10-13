import http from "node:http";
import { Worker } from "bullmq";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import { QUEUE_NAME, createRedisConnection } from "./queue.js";
import { createSearch } from "./search.js";

const config = loadConfig();
if (!config.redisUrl || !config.searchUrl) {
  log.error("the worker needs REDIS_URL and SEARCH_URL");
  process.exit(1);
}
const search = createSearch(config.searchUrl);
const connection = createRedisConnection(config.redisUrl);

// Consumes "item-created" events published by the API and indexes each item
// into OpenSearch. A failed job is retried with backoff (see queue.js), so
// search being briefly down doesn't lose index updates.
const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    if (job.name === "item-created") await search.indexItem(job.data);
  },
  { connection, concurrency: 5 }
);

worker.on("completed", (job) => log.info("job completed", { job_id: job.id, job: job.name }));
worker.on("failed", (job, err) =>
  log.error("job failed", { job_id: job?.id, job: job?.name, attempt: job?.attemptsMade, error: err.message })
);
worker.on("error", (err) => log.error("worker error", { error: err.message }));

// Tiny HTTP server so Kubernetes can probe the worker (it has no other port).
const probe = http.createServer((req, res) => {
  const healthy = worker.isRunning();
  res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: healthy ? "ok" : "stopped" }));
});
probe.listen(Number(process.env.WORKER_HEALTH_PORT || 4001));

async function shutdown(signal) {
  log.info("worker shutting down", { signal });
  probe.close();
  await worker.close(); // waits for the current job to finish
  await connection.quit();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

log.info("worker started", { queue: QUEUE_NAME });
