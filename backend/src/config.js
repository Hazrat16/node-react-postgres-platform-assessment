// Central place for reading configuration from the environment.
// Nothing here has a default for credentials: if a required variable is
// missing the process fails fast at startup instead of silently connecting
// with a baked-in password.

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

// DB_WRITE_URL wins if set; otherwise build it from the individual
// DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME variables.
function writeUrl() {
  if (process.env.DB_WRITE_URL) return process.env.DB_WRITE_URL;
  const user = encodeURIComponent(required("DB_USER"));
  const password = encodeURIComponent(required("DB_PASSWORD"));
  const host = required("DB_HOST");
  const port = process.env.DB_PORT || "5432";
  const name = required("DB_NAME");
  return `postgres://${user}:${password}@${host}:${port}/${name}`;
}

export function loadConfig() {
  const dbWriteUrl = writeUrl();
  return {
    port: Number(process.env.PORT || 4000),
    dbWriteUrl,
    // No replica configured -> reads go to the primary.
    dbReadUrl: process.env.DB_READ_URL || dbWriteUrl,
    // Optional platform services: when unset, the API still serves items and
    // reports the service as "disabled" in its health endpoint.
    redisUrl: process.env.REDIS_URL || null,
    searchUrl: process.env.SEARCH_URL || null,
  };
}
