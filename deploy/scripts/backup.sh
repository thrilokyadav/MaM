#!/usr/bin/env bash
#
# (C) Copyright 2026 MAM Platform. All rights reserved.
#
# Production backup for the MAM platform (Technical Architecture Document
# 2.9.3 Backup & Disaster Recovery). Backs up:
#   1. PostgreSQL (full logical dump, gzip-compressed).
#   2. Elasticsearch (snapshot to a filesystem repository, registered
#      against the same volume mounted into the elasticsearch container
#      at /usr/share/elasticsearch/snapshots -- see docker-compose.prod.yml's
#      mam-es-snapshots volume).
#
# MinIO/S3 binary data is NOT backed up by this script: object storage
# durability is expected to come from the storage layer itself (S3
# versioning/replication, or your infrastructure's own volume/disk backup
# for the mam-prod-minio-data volume) -- see README-DEPLOYMENT.md's
# "Backup & Restore" section for why binaries are handled separately from
# the two databases below.
#
# Usage:
#   ./backup.sh [BACKUP_DIR]
#
# BACKUP_DIR defaults to ./backups (relative to this script's own
# directory) if not given, and can also be set via the BACKUP_DIR
# environment variable. Each run creates a timestamped subdirectory, so
# repeated runs never overwrite a previous backup.
#
# Cron examples (see README-DEPLOYMENT.md for the full explanation):
#   # Daily PostgreSQL + weekly Elasticsearch snapshot, 02:00 server time
#   0 2 * * *  cd /path/to/deploy/scripts && ./backup.sh /mnt/backups/mam >> /var/log/mam-backup.log 2>&1
#
# This script only ever reads from the running containers (pg_dump,
# Elasticsearch snapshot API) -- it never stops or restarts a service, so
# it is safe to run against a live production stack.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found. Copy .env.prod.example to .env first." >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

BACKUP_DIR="${1:-${BACKUP_DIR:-$SCRIPT_DIR/backups}}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="$BACKUP_DIR/$STAMP"
mkdir -p "$RUN_DIR"

COMPOSE="docker compose -f $DEPLOY_DIR/docker-compose.prod.yml --env-file $ENV_FILE"

PG_CONTAINER="mam-prod-postgres"
ES_CONTAINER="mam-prod-elasticsearch"
# http, not https: docker-compose.prod.yml sets
# xpack.security.http.ssl.enabled=false (auth is enabled, transport
# encryption is not, for this baseline single-node deployment -- see
# README-DEPLOYMENT.md "Elasticsearch security" note on hardening this
# further with TLS between Nuxeo/ops tooling and ES).
ES_URL="http://localhost:9200"
ES_REPO_NAME="mam-fs-backup"
ES_SNAPSHOT_NAME="mam-snapshot-$STAMP"
# Matches the elasticsearch service's mam-es-snapshots volume mount in
# docker-compose.prod.yml -- the ES filesystem snapshot repository must
# point at a path that is actually inside the container.
ES_REPO_PATH="/usr/share/elasticsearch/snapshots"

echo "=== MAM backup started at $STAMP UTC -> $RUN_DIR ==="

# ---------------------------------------------------------------------
# 1. PostgreSQL logical dump
# ---------------------------------------------------------------------
echo "--- PostgreSQL: dumping $PG_DB ---"
$COMPOSE exec -T postgres \
  pg_dump -U "$PG_USER" -d "$PG_DB" --format=plain --no-owner --no-privileges \
  | gzip -9 > "$RUN_DIR/postgres-$PG_DB-$STAMP.sql.gz"

PG_SIZE="$(du -h "$RUN_DIR/postgres-$PG_DB-$STAMP.sql.gz" | cut -f1)"
echo "PostgreSQL dump complete: postgres-$PG_DB-$STAMP.sql.gz ($PG_SIZE)"

# ---------------------------------------------------------------------
# 2. Elasticsearch snapshot
#
# Registers a filesystem snapshot repository (idempotent -- PUT with the
# same body is a no-op if it already matches) backed by the container's
# mam-es-snapshots volume, then triggers a synchronous snapshot of every
# index (`wait_for_completion=true`, acceptable since ES snapshots are
# incremental after the first one and this runs off-peak per the cron
# guidance above).
# ---------------------------------------------------------------------
echo "--- Elasticsearch: registering snapshot repository '$ES_REPO_NAME' ---"
$COMPOSE exec -T elasticsearch curl -fsS -u "elastic:$ELASTIC_PASSWORD" \
  -X PUT "$ES_URL/_snapshot/$ES_REPO_NAME" \
  -H 'Content-Type: application/json' \
  -d "{\"type\":\"fs\",\"settings\":{\"location\":\"$ES_REPO_PATH\",\"compress\":true}}" \
  > "$RUN_DIR/es-repo-register.json"

echo "--- Elasticsearch: creating snapshot '$ES_SNAPSHOT_NAME' (this can take a while on the first run) ---"
$COMPOSE exec -T elasticsearch curl -fsS -u "elastic:$ELASTIC_PASSWORD" \
  -X PUT "$ES_URL/_snapshot/$ES_REPO_NAME/$ES_SNAPSHOT_NAME?wait_for_completion=true" \
  -H 'Content-Type: application/json' \
  -d '{"indices":"*","ignore_unavailable":true,"include_global_state":true}' \
  > "$RUN_DIR/es-snapshot-$STAMP.json"

if grep -q '"state":"SUCCESS"' "$RUN_DIR/es-snapshot-$STAMP.json"; then
  echo "Elasticsearch snapshot complete: $ES_SNAPSHOT_NAME"
else
  echo "WARNING: Elasticsearch snapshot response did not report SUCCESS -- inspect $RUN_DIR/es-snapshot-$STAMP.json" >&2
fi

# ---------------------------------------------------------------------
# Manifest, for restore.sh and for a human skimming the backup directory.
# ---------------------------------------------------------------------
cat > "$RUN_DIR/manifest.txt" <<EOF
MAM backup manifest
Timestamp (UTC):      $STAMP
PostgreSQL database:  $PG_DB
PostgreSQL dump file: postgres-$PG_DB-$STAMP.sql.gz
Elasticsearch repo:   $ES_REPO_NAME
Elasticsearch snapshot: $ES_SNAPSHOT_NAME
EOF

echo "=== MAM backup finished: $RUN_DIR ==="
