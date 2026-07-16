#!/bin/bash
# docker/postgres/standby/init-standby.sh
# Runs on standby container first boot to initialize replication from primary.
# Mount as /docker-entrypoint-initdb.d/init-standby.sh

set -e

PRIMARY_HOST="${PRIMARY_HOST:-postgres}"
REPLICATION_USER="${REPLICATION_USER:-replicator}"
REPLICATION_PASSWORD="${REPLICATION_PASSWORD:-replicator}"
DATA_DIR="/var/lib/postgresql/data"

# Only run if the data directory is empty (first boot)
if [ -f "${DATA_DIR}/PG_VERSION" ]; then
  echo "[standby-init] Data directory already initialized — skipping basebackup."
  exit 0
fi

echo "[standby-init] Waiting for primary to be ready..."
until PGPASSWORD="${REPLICATION_PASSWORD}" pg_isready -h "${PRIMARY_HOST}" -U "${REPLICATION_USER}" -d stellar_indigopay -t 2; do
  echo "[standby-init] Primary not ready yet — retrying in 3s..."
  sleep 3
done

echo "[standby-init] Primary is ready. Running pg_basebackup..."
PGPASSWORD="${REPLICATION_PASSWORD}" pg_basebackup \
  -h "${PRIMARY_HOST}" \
  -p 5432 \
  -U "${REPLICATION_USER}" \
  -D "${DATA_DIR}" \
  -P \
  -R \
  -X stream \
  --no-password

echo "[standby-init] pg_basebackup completed. Standby is ready to start replicating."
