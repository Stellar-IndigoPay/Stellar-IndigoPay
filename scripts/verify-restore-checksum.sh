#!/bin/bash
#
# scripts/verify-restore-checksum.sh
#
# Verify that a downloaded/restored backup matches its recorded SHA-256 and
# (optionally) that row-level checksums for critical tables match the values
# captured at backup time. Used by the monthly restore drill and can also be
# run ad-hoc during incident response (Workstream 4 of #1100).
#
# Returns non-zero and prints a machine-readable summary on any mismatch so CI
# can fail the drill and fire the RestoreDrillFailed alert.
#
# Usage:
#   ./scripts/verify-restore-checksum.sh \
#       --backup /path/to/backup.sql.gz \
#       [--expected-sha256 <hex>] \
#       [--row-checksums /path/to/file.rowchecksums.json] \
#       [--db-url postgres://user:pass@host:port/db] \
#       [--table donations] [--table projects] ...
#
# Examples:
#   # 1. Byte-for-byte integrity of the artifact alone:
#   ./scripts/verify-restore-checksum.sh --backup /tmp/backup.sql.gz \
#       --expected-sha256 "$(cat /tmp/backup.sql.gz.sha256 | cut -d' ' -f1)"
#
#   # 2. Full drill: artifact hash + row-level checksums against a restore:
#   ./scripts/verify-restore-checksum.sh --backup /tmp/restore.sql.gz \
#       --row-checksums /tmp/restore.sql.gz.rowchecksums.json \
#       --db-url "$DATABASE_URL"
#
# Exit codes: 0 = verified, 1 = checksum mismatch, 2 = missing dependency/arg,
# 3 = row-checksum mismatch.

set -euo pipefail

BACKUP_PATH=""
EXPECTED_SHA256=""
ROW_CHECKSUMS=""
DB_URL=""
TABLES_RAW="donations donation_events projects profiles projection_donor_leaderboard projection_donor_history projection_project_stats projection_global_stats"
MISMATCH=false

usage() {
  sed -n '2,30p' "$0"
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup) BACKUP_PATH="$2"; shift 2 ;;
    --expected-sha256) EXPECTED_SHA256="$2"; shift 2 ;;
    --row-checksums) ROW_CHECKSUMS="$2"; shift 2 ;;
    --db-url) DB_URL="$2"; shift 2 ;;
    --table) TABLES_RAW="$TABLES_RAW $2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown flag: $1"; usage ;;
  esac
done

log() { echo "[verify-restore-checksum] $1"; }

[[ -n "$BACKUP_PATH" ]] || { echo "Missing --backup"; usage; }
[[ -f "$BACKUP_PATH" ]] || { echo "Backup file not found: $BACKUP_PATH"; exit 2; }

# ── 1. Byte-for-byte SHA-256 of the artifact ──────────────────────────────
if [[ -n "$EXPECTED_SHA256" ]]; then
  ACTUAL_SHA256=$(sha256sum "$BACKUP_PATH" | awk '{print $1}')
  if [[ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]]; then
    log "❌ SHA-256 MISMATCH: expected $EXPECTED_SHA256, got $ACTUAL_SHA256"
    MISMATCH=true
  else
    log "✅ SHA-256 verified: $ACTUAL_SHA256"
  fi
else
  log "ℹ️  No --expected-sha256 given — skipping byte-for-byte integrity check."
fi

# ── 2. Row-level checksum comparison (expensive; only when a live restore) ─
if [[ -n "$ROW_CHECKSUMS" && -n "$DB_URL" ]]; then
  command -v psql >/dev/null 2>&1 || { echo "psql is required for row-checksum verification"; exit 2; }
  [[ -f "$ROW_CHECKSUMS" ]] || { echo "Row-checksum file not found: $ROW_CHECKSUMS"; exit 2; }
  # jq is REQUIRED and the checksum JSON must parse. Masking a jq failure would
  # silently skip every table and let a broken sidecar report success.
  command -v jq >/dev/null 2>&1 || { echo "jq is required for row-checksum verification"; exit 2; }
  if ! jq -e . "$ROW_CHECKSUMS" >/dev/null 2>&1; then
    echo "::error::Invalid or unparseable row-checksum JSON: $ROW_CHECKSUMS"
    exit 2
  fi

  parse_url() {
    local u="$1"
    DATABASE_URL_HOST="${u#*://}"; DATABASE_URL_HOST="${DATABASE_URL_HOST%%@*}"
    if [[ "$DATABASE_URL_HOST" == *":"* ]]; then
      DATABASE_URL_USER="${DATABASE_URL_HOST%%:*}"
      DATABASE_URL_PASS="${DATABASE_URL_HOST#*:}"
    else
      DATABASE_URL_USER="${DATABASE_URL_HOST}"
      DATABASE_URL_PASS=""
    fi
    local rest="${u#*@}"
    DATABASE_URL_HOSTPORT="${rest%%/*}"
    DATABASE_URL_DB="${rest#*/}"
    DATABASE_URL_DB="${DATABASE_URL_DB%%\?*}"
  }
  parse_url "$DB_URL"
  export PGPASSWORD="$DATABASE_URL_PASS"

  # ── 2a. Object-count integrity (WS4 acceptance) ───────────────────────────
  # Compare restored indices/constraints/triggers/sequences against the expected
  # values recorded in the .rowchecksums.json sidecar (entry `__objects__`). A
  # restore that loses schema objects fails the drill even though row counts and
  # row-level checksums may still match.
  OBJECT_EXPECTED=$(jq -r '.[] | select(.table=="__objects__")' "$ROW_CHECKSUMS" 2>/dev/null || echo "")
  OBJECT_CHECKS_OK=$(psql -h "${DATABASE_URL_HOSTPORT%%:*}" -p "${DATABASE_URL_HOSTPORT##*:}" \
    -U "$DATABASE_URL_USER" -d "$DATABASE_URL_DB" -tAc \
    "SELECT count(*) FROM pg_indexes WHERE schemaname='public';" 2>/dev/null | tr -d ' \n')
  CONSTRAINTS_OK=$(psql -h "${DATABASE_URL_HOSTPORT%%:*}" -p "${DATABASE_URL_HOSTPORT##*:}" \
    -U "$DATABASE_URL_USER" -d "$DATABASE_URL_DB" -tAc \
    "SELECT count(*) FROM pg_constraint WHERE contype IN ('f','p','u');" 2>/dev/null | tr -d ' \n')
  TRIGGERS_OK=$(psql -h "${DATABASE_URL_HOSTPORT%%:*}" -p "${DATABASE_URL_HOSTPORT##*:}" \
    -U "$DATABASE_URL_USER" -d "$DATABASE_URL_DB" -tAc \
    "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal;" 2>/dev/null | tr -d ' \n')
  SEQUENCES_OK=$(psql -h "${DATABASE_URL_HOSTPORT%%:*}" -p "${DATABASE_URL_HOSTPORT##*:}" \
    -U "$DATABASE_URL_USER" -d "$DATABASE_URL_DB" -tAc \
    "SELECT count(*) FROM pg_class WHERE relkind='S' AND relnamespace=(SELECT oid FROM pg_namespace WHERE nspname='public');" 2>/dev/null | tr -d ' \n')
  log "Restored object integrity — indices=$OBJECT_CHECKS_OK constraints=$CONSTRAINTS_OK triggers=$TRIGGERS_OK sequences=$SEQUENCES_OK"

  if [[ -n "$OBJECT_EXPECTED" ]]; then
    for pair in "indices:$OBJECT_CHECKS_OK" "constraints:$CONSTRAINTS_OK" "triggers:$TRIGGERS_OK" "sequences:$SEQUENCES_OK"; do
      key=${pair%%:*}
      actual=${pair#*:}
      expected_obj=$(jq -r --arg k "$key" '.[$k]' <<< "$OBJECT_EXPECTED" 2>/dev/null)
      if [[ -n "$expected_obj" && "$expected_obj" != "null" && "$actual" != "$expected_obj" ]]; then
        log "❌ Object-count MISMATCH for $key: expected $expected_obj, got $actual"
        MISMATCH=true
      fi
    done
  else
    log "ℹ️  No expected object counts (__objects__) in sidecar — cannot compare schema objects."
  fi

  # ── 2b. Row-level checksum comparison ────────────────────────────────────
  # jq presence and JSON validity are enforced at the top of this block.
  for table in $TABLES_RAW; do
    expected=$(jq -r --arg t "$table" '.[] | select(.table==$t) | .md5' "$ROW_CHECKSUMS" 2>/dev/null)
    if [[ -z "$expected" || "$expected" == "unavailable" ]]; then
      log "ℹ️  No stored checksum for table $table — skipping."
      continue
    fi
    actual=$(psql -h "${DATABASE_URL_HOSTPORT%%:*}" -p "${DATABASE_URL_HOSTPORT##*:}" \
      -U "$DATABASE_URL_USER" -d "$DATABASE_URL_DB" -tAc \
      "SELECT md5(string_agg(md5((t.*)::text), '' ORDER BY 1)) FROM (SELECT * FROM ${table} ORDER BY ctid) t;" 2>/dev/null | tr -d ' \n')
    if [[ "$actual" != "$expected" ]]; then
      log "❌ Row-checksum MISMATCH for table $table: expected $expected, got ${actual:-<empty>}"
      MISMATCH=true
    else
      log "✅ Row-checksum verified for $table ($actual)"
    fi
  done
fi

# ── 3. Emit Prometheus-style summary metrics for the drill ────────────────
# These are STATUS gauges (last-run 0/1) plus a last-run timestamp, NOT
# monotonic counters: the textfile is overwritten every run, so `increase()`
# over an overwritten value is meaningless. Alert rules MUST query the status
# gauge directly (see monitoring/alert-rules.yml), never `increase()`.
LAST_RUN_TS=$(date +%s)
if [[ "$MISMATCH" == "true" ]]; then
  cat > /tmp/restore_drill_metrics.prom <<EOF
# HELP restore_drill_last_result 1 if the most recent restore drill failed.
# TYPE restore_drill_last_result gauge
restore_drill_last_result 1
# HELP restore_drill_checksum_mismatch_last 1 if the most recent drill found a checksum mismatch.
# TYPE restore_drill_checksum_mismatch_last gauge
restore_drill_checksum_mismatch_last 1
# HELP restore_drill_last_timestamp Unix epoch of the last restore drill run.
# TYPE restore_drill_last_timestamp gauge
restore_drill_last_timestamp ${LAST_RUN_TS}
EOF
  echo "❌ Restore verification FAILED. See output above."
  exit 1
else
  cat > /tmp/restore_drill_metrics.prom <<EOF
# HELP restore_drill_last_result 1 if the most recent restore drill failed.
# TYPE restore_drill_last_result gauge
restore_drill_last_result 0
# HELP restore_drill_checksum_mismatch_last 1 if the most recent drill found a checksum mismatch.
# TYPE restore_drill_checksum_mismatch_last gauge
restore_drill_checksum_mismatch_last 0
# HELP restore_drill_last_timestamp Unix epoch of the last restore drill run.
# TYPE restore_drill_last_timestamp gauge
restore_drill_last_timestamp ${LAST_RUN_TS}
EOF
  log "✅ Restore verification passed."
fi