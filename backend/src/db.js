import pg from "pg";
import { log } from "./logger.js";

const { Pool } = pg;

// Connection-level failures (replica down, DNS, timeouts, admin shutdown) as
// opposed to query errors like a syntax error, which must not be retried.
function isConnectionError(err) {
  return (
    ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNRESET"].includes(err.code) ||
    /^(08|57P0)/.test(err.code || "") ||
    /timeout|terminated/i.test(err.message)
  );
}

// Read/write split: two pools pointed at different URLs. DB_WRITE_URL is the
// primary, DB_READ_URL a streaming replica. The routing decision lives here,
// in application code: callers pick write() or read() explicitly.
export function createDb({ dbWriteUrl, dbReadUrl }) {
  const writePool = new Pool({ connectionString: dbWriteUrl, max: 10 });
  const readPool = new Pool({ connectionString: dbReadUrl, max: 10 });

  for (const [name, pool] of [["write", writePool], ["read", readPool]]) {
    pool.on("error", (err) => log.error("idle pg client error", { pool: name, error: err.message }));
  }

  return {
    async initSchema() {
      await writePool.query(`
        CREATE TABLE IF NOT EXISTS items (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
    },

    // INSERT/UPDATE/DELETE, and any read that must see the caller's own
    // latest write, go to the primary.
    write(query, params) {
      return writePool.query(query, params);
    },

    // Plain SELECTs go to the replica. If the replica is unreachable we fall
    // back to the primary: slightly more load on the writer beats failing
    // the request.
    async read(query, params) {
      try {
        return await readPool.query(query, params);
      } catch (err) {
        if (!isConnectionError(err)) throw err;
        log.warn("read replica unavailable, falling back to primary", { error: err.message });
        return writePool.query(query, params);
      }
    },

    async pingWrite() {
      await writePool.query("SELECT 1");
    },

    async close() {
      await Promise.all([writePool.end(), readPool.end()]);
    },
  };
}
