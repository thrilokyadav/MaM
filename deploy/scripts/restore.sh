#!/usr/bin/env bash
#
# (C) Copyright 2026 MAM Platform. All rights reserved.
#
# Restore a MAM platform backup produced by backup.sh (Technical
# Architecture Document 2.9.3 Backup & Disaster Recovery).
#
# Restores:
#   1. PostgreSQL, from the run's `postgres-<db>-<timestamp>.sql.gz` dump.
#   2. Elasticsearch, by pointing you at the exact snapshot restore API
#      call for the snapshot recorded in that run's manifest.txt (NOT
#      run automatically -- see the "Elasticsearch" section below for why).
#
# Usage:
#   ./restore.sh BACKUP_RUN_DIR
#
# BACKUP_RUN_DIR is one timestamped run directory produced by backup.sh,
# e.g. ./backups/20260910T020000Z (NOT the top-level backups/ directory
# itself).
#
# WARNING: this is a DESTRUCTIVE operation. Restoring PostgreSQL drops
# and recreates every table in the target database before loading the
# dump. Do not run this against a database you intend to keep unless you
# have already taken a fresh backup of its current state.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 BACKUP_RUN_DIR" >&2
  exit 1
fi
RUN_DIR="$1"
if [ ! -d "$RUN_DIR" ]; then
  echo "ERROR: $RUN_DIR is not a directory." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found. Copy .env.prod.example to .env first." >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

COMPOSE="docker compose -f $DEPLOY_DIR/docker-compose.prod.yml --env-file $ENV_FILE"
PG_CONTAINER="mam-prod-postgres"

MANIFEST="$RUN_DIR/manifest.txt"
if [ ! -f "$MANIFEST" ]; then
  echo "ERROR: $MANIFEST not found -- is $RUN_DIR a valid backup.sh run directory?" >&2
  exit 1
fi
echo "=== Restoring from $RUN_DIR ==="
cat "$MANIFEST"
echo

DUMP_FILE=$(find "$RUN_DIR" -maxdepth 1 -name 'postgres-*.sql.gz' | head -n1)
if [ -z "$DUMP_FILE" ]; then
  echo "ERROR: no postgres-*.sql.gz dump found in $RUN_DIR." >&2
  exit 1
fi

# ---------------------------------------------------------------------
# Confirmation gate. This is a destructive operation against a live
# database; require an explicit, typed confirmation rather than a bare
# -y flag that could be scripted past accidentally.
# ---------------------------------------------------------------------
echo "About to restore PostgreSQL database '$PG_DB' from:"
echo "  $DUMP_FILE"
echo "This DROPS every existing table in '$PG_DB' first. This cannot be undone."
read -r -p "Type the database name ('$PG_DB') to confirm: " CONFIRM
if [ "$CONFIRM" != "$PG_DB" ]; then
  echo "Confirmation did not match. Aborting -- nothing was changed." >&2
  exit 1
fi

# ---------------------------------------------------------------------
# 1. PostgreSQL restore.
#
# Stop Nuxeo first so it is not writing to the database mid-restore (the
# repository backend must be quiescent for a clean logical restore); the
# database container itself stays up throughout.
# ---------------------------------------------------------------------
echo "--- Stopping the nuxeo container (postgres/elasticsearch/minio stay up) ---"
$COMPOSE stop nuxeo

echo "--- Dropping and recreating public schema in '$PG_DB' ---"
$COMPOSE exec -T postgres psql -U "$PG_USER" -d "$PG_DB" -c \
  "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO \"$PG_USER\";"

echo "--- Restoring PostgreSQL dump ---"
gunzip -c "$DUMP_FILE" | $COMPOSE exec -T postgres psql -U "$PG_USER" -d "$PG_DB"

echo "--- Restarting the nuxeo container ---"
$COMPOSE start nuxeo

echo "PostgreSQL restore complete."
echo

# ---------------------------------------------------------------------
# 2. Elasticsearch restore -- printed as guidance, NOT executed
#    automatically.
#
# Unlike PostgreSQL (the single source of truth for document content and
# metadata), the Elasticsearch index is a derived, rebuildable artifact:
# Nuxeo can fully reindex it from the repository via the standard
# `GlobalRepositoryElasticSearchIndexing`-driven "Reindex all documents"
# admin operation. Restoring an ES snapshot is faster for a large
# repository, but it must be done AFTER the PostgreSQL restore above (so
# the snapshot's document set actually matches the restored repository
# state) and requires closing/deleting the live index first, which this
# script deliberately does not automate -- get the exact repository/
# snapshot names right by hand for a DR event, not from a generic script.
# ---------------------------------------------------------------------
ES_REPO_NAME="mam-fs-backup"
if grep -q '^Elasticsearch snapshot:' "$MANIFEST"; then
  ES_SNAPSHOT_NAME=$(grep '^Elasticsearch snapshot:' "$MANIFEST" | awk '{print $NF}')
  cat <<EOF
--- Elasticsearch restore (manual step) ---
This script does NOT restore Elasticsearch automatically. To restore the
snapshot recorded for this backup ('$ES_SNAPSHOT_NAME'), run, against a
running elasticsearch container that already has the '$ES_REPO_NAME'
repository registered (backup.sh registers it on every run):

  docker compose -f $DEPLOY_DIR/docker-compose.prod.yml --env-file $ENV_FILE \\
    exec -T elasticsearch curl -fsS -u "elastic:\$ELASTIC_PASSWORD" \\
    -X POST "http://localhost:9200/_all/_close"

  docker compose -f $DEPLOY_DIR/docker-compose.prod.yml --env-file $ENV_FILE \\
    exec -T elasticsearch curl -fsS -u "elastic:\$ELASTIC_PASSWORD" \\
    -X POST "http://localhost:9200/_snapshot/$ES_REPO_NAME/$ES_SNAPSHOT_NAME/_restore?wait_for_completion=true"

Alternatively, skip the snapshot restore entirely and trigger a full
reindex from the now-restored PostgreSQL repository via Nuxeo's Admin
Center ("Reindex all documents") once the nuxeo container is back up --
slower, but always consistent with the just-restored database and
requires no ES-specific steps.
EOF
else
  echo "No Elasticsearch snapshot recorded in this backup's manifest -- reindex from Nuxeo Admin Center instead."
fi

echo
echo "=== Restore finished. Verify the application at your configured domain. ==="

# ---------------------------------------------------------------------
# Automating backups via cron (see also backup.sh's own header comment):
#
#   # Daily PostgreSQL + Elasticsearch snapshot backup, 02:00 server time
#   0 2 * * *   cd /path/to/deploy/scripts && ./backup.sh /mnt/backups/mam >> /var/log/mam-backup.log 2>&1
#
#   # Weekly full Elasticsearch snapshot verification / restore drill,
#   # Sunday 03:00 -- restore.sh is NOT meant to run unattended (it
#   # prompts for confirmation), so a weekly DR drill should be a manual
#   # or semi-scripted exercise against a STAGING stack, not this cron
#   # entry. Use this slot instead to prune old backup run directories:
#   0 3 * * 0   find /mnt/backups/mam -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
# ---------------------------------------------------------------------
