import http from "node:http";
import { Worker } from "bullmq";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import { QUEUE_NAME, createRedisConnection } from "./queue.js";

const config = loadConfig();
if (!config.redisUrl) {
  log.error("the worker needs REDIS_URL");
  process.exit(1);
}
const connection = createRedisConnection(config.redisUrl);

// Consumes "item-created" events published by the API. Placeholder for real
// async work (search indexing, notifications, cache invalidation).
const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    log.info("processing job", { job_id: job.id, job: job.name, data: job.data });
  },
  { connection }
);

worker.on("completed", (job) => log.info("job completed", { job_id: job.id, job: job.name }));
worker.on("failed", (job, err) =>
  log.error("job failed", { job_id: job?.id, job: job?.name, error: err.message })
);
worker.on("error", (err) => log.error("worker error", { error: err.message }));

// Tiny HTTP server so an orchestrator can probe the worker.
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
