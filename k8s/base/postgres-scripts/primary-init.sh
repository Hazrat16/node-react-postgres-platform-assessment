#!/bin/sh
# Runs once, on the primary's first start (docker-entrypoint-initdb.d).
# Creates the replication role and allows it to stream WAL.
set -eu

psql -v ON_ERROR_STOP=1 -v pw="$REPLICATION_PASSWORD" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD :'pw';
SQL

echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"
