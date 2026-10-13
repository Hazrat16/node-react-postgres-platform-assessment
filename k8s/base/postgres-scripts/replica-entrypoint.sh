#!/bin/sh
# Entrypoint for the read replica. On first start it clones the primary with
# pg_basebackup (-R writes standby.signal + primary_conninfo), then hands off
# to the normal postgres entrypoint, which starts a read-only hot standby
# that keeps streaming WAL from the primary.
set -eu
: "${PRIMARY_HOST:?PRIMARY_HOST is required}"
: "${REPLICATION_PASSWORD:?REPLICATION_PASSWORD is required}"

# The official image ships gosu (newer tags) or su-exec (older alpine tags).
as_postgres() {
  if command -v gosu >/dev/null; then gosu postgres "$@"; else su-exec postgres "$@"; fi
}

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "replica: no data yet, cloning from $PRIMARY_HOST"
  until pg_isready -q -h "$PRIMARY_HOST" -p "${PRIMARY_PORT:-5432}"; do
    echo "replica: waiting for primary..."; sleep 2
  done
  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  chmod 700 "$PGDATA"
  export PGPASSWORD="$REPLICATION_PASSWORD"
  until as_postgres pg_basebackup -h "$PRIMARY_HOST" -p "${PRIMARY_PORT:-5432}" \
      -U replicator -D "$PGDATA" -R -X stream; do
    echo "replica: base backup failed, retrying"; rm -rf "${PGDATA:?}"/*; sleep 3
  done
  unset PGPASSWORD
fi

exec docker-entrypoint.sh postgres -c hot_standby=on
