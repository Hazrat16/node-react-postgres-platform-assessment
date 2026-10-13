import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { log } from "./logger.js";
import { createQueue, createRedisConnection } from "./queue.js";
import { createSearch } from "./search.js";

const config = loadConfig();

const db = createDb(config);

let redis = null;
let queue = null;
if (config.redisUrl) {
  redis = createRedisConnection(config.redisUrl);
  redis.on("error", (err) => log.error("redis connection error", { error: err.message }));
  queue = createQueue(redis);
} else {
  log.warn("REDIS_URL not set: queue disabled");
}
const search = config.searchUrl ? createSearch(config.searchUrl) : null;

let ready = false;
const app = createApp({ db, redis, queue, search, isReady: () => ready });

// Listen immediately so the liveness probe passes while we wait for the
// database; readiness reports 503 until the schema is in place.
const server = app.listen(config.port, () => log.info("backend listening", { port: config.port }));

// Retry schema creation until it works instead of crashing: Postgres may
// still be starting. Exiting would only push the pod into CrashLoopBackOff
// and delay recovery; staying up but unready is the better signal.
async function initWithRetry() {
  for (let i = 1; ; i++) {
    try {
      await db.initSchema();
      return;
    } catch (err) {
      log.warn("database not ready, retrying", { attempt: i, error: err.message });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// On SIGTERM (rolling update, scale-down, docker stop): stop accepting new
// connections, let in-flight requests finish, then close the pools.
async function shutdown(signal) {
  log.info("shutting down", { signal });
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  server.close(async () => {
    await Promise.allSettled([db.close(), queue?.close(), redis?.quit()]);
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

initWithRetry()
  .then(() => {
    ready = true;
    log.info("schema ready, accepting traffic");
  })
  .catch((err) => {
    log.error("failed to initialize schema", { error: err.message });
    process.exit(1);
  });
