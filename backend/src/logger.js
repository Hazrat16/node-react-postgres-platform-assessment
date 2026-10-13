// Minimal structured (JSON, one line per event) logger. Fluent Bit parses
// these lines so fields like level, msg, route and status can be filtered
// in Loki without regex.
function emit(level, msg, fields = {}) {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    service: process.env.SERVICE_NAME || "backend",
    msg,
    ...fields,
  });
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const log = {
  info: (msg, fields) => emit("info", msg, fields),
  warn: (msg, fields) => emit("warn", msg, fields),
  error: (msg, fields) => emit("error", msg, fields),
};
