#!/usr/bin/env bash
#
# test/chaos/run-chaos.sh — host-side orchestrator for the chaos suite.
#
# Brings up the docker-compose.chaos.yml topology, coordinates the two
# host-injected faults (Redis crash, Postgres failover) with the in-container
# driver via marker files, then reports the driver's exit code.
#
# Usage:
#   bash test/chaos/run-chaos.sh
#
# Exit code mirrors the driver: 0 when every chaos scenario passed.
#
set -euo pipefail

COMPOSE_FILE="docker-compose.chaos.yml"
COMPOSE="docker compose -f $COMPOSE_FILE"
RUN_DIR=".chaos-run"
IMAGE="indigopay-backend-test:ci"

cd "$(dirname "$0")/../.." # repo root

log() { echo -e "\n\033[1m[chaos-host] $*\033[0m"; }

cleanup() {
  log "tearing down chaos topology"
  $COMPOSE down -v --remove-orphans >/dev/null 2>&1 || true
  # Preserve summary.json (and any other results) for the nightly CI to
  # upload as an artifact / write to the job summary AFTER this script
  # exits. Only the transient marker files are cleared.
  rm -f "$RUN_DIR"/*.marker 2>/dev/null || sudo rm -f "$RUN_DIR"/*.marker 2>/dev/null || true
}
trap cleanup EXIT

# ── Build the backend test image if it isn't present ────────────────────────
# CI (chaos-nightly.yml) pre-builds the image with GHA cache and sets
# CHAOS_SKIP_BUILD=1; local runs build it on demand.
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  if [ "${CHAOS_SKIP_BUILD:-0}" = "1" ]; then
    log "backend test image '$IMAGE' not found and CHAOS_SKIP_BUILD=1 — aborting"
    exit 1
  fi
  log "backend test image '$IMAGE' not found — building it (this takes a while)"
  docker build -f backend/Dockerfile.test -t "$IMAGE" .
fi

mkdir -p "$RUN_DIR"
# World-writable so both the host user and the (root) container can create
# and clean up marker files across runs.
chmod 777 "$RUN_DIR"
# Clear transient state from any previous run. summary.json is removed too
# so a stale summary from a prior run can never be mistaken for this run's
# results if the driver dies before writing a fresh one.
rm -f "$RUN_DIR"/*.marker 2>/dev/null || true
rm -f "$RUN_DIR"/summary.json 2>/dev/null || true

# ── Start topology ──────────────────────────────────────────────────────────
log "starting chaos topology ($COMPOSE_FILE)"
$COMPOSE up -d --wait

backend_alive() {
  local cid
  cid=$($COMPOSE ps -q backend 2>/dev/null || true)
  [ -n "$cid" ] && [ "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null)" = "true" ]
}

wait_for_marker() {
  local marker="$1"
  local timeout_sec="${2:-600}"
  local waited=0
  while [ "$waited" -lt "$timeout_sec" ]; do
    if [ -f "$marker" ]; then
      log "marker observed: $marker"
      return 0
    fi
    if ! backend_alive; then
      log "backend container exited before '$marker' appeared — aborting"
      return 1
    fi
    sleep 2
    waited=$((waited + 2))
  done
  log "timed out waiting for marker: $marker"
  return 1
}

wait_healthy() {
  local service="$1"
  local cid
  cid=$($COMPOSE ps -q "$service")
  local waited=0
  while [ "$waited" -lt 120 ]; do
    local status
    status=$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo "none")
    [ "$status" = "healthy" ] && return 0
    sleep 2
    waited=$((waited + 2))
  done
  log "$service did not become healthy after restart"
  return 1
}

# Host-injected fault dance: wait for the driver to signal readiness, inject
# the fault, wait for the driver's mid-fault assertions, remove the fault,
# then wait for the scenario to finish.
fault_dance() {
  local id="$1"
  local service="$2"
  local inject_cmd="$3"
  local remove_cmd="$4"

  # The in-container driver writes/waits for files named "<marker>.marker".
  log "scenario $id: waiting for driver to arm the fault"
  wait_for_marker "$RUN_DIR/$id.ready.marker" 600

  log "scenario $id: injecting fault — stopping $service"
  eval "$inject_cmd"

  touch "$RUN_DIR/$id.faulted.marker"

  log "scenario $id: waiting for driver mid-fault assertions"
  wait_for_marker "$RUN_DIR/$id.during.marker" 600

  log "scenario $id: removing fault — starting $service"
  eval "$remove_cmd"
  wait_healthy "$service"

  touch "$RUN_DIR/$id.recovered.marker"

  log "scenario $id: waiting for driver to finish"
  wait_for_marker "$RUN_DIR/$id.done.marker" 600
}

# ── Run scenarios 01 (Redis crash) and 02 (Postgres failover) ───────────────
fault_dance "01" "redis" \
  "$COMPOSE stop redis" \
  "$COMPOSE start redis"

fault_dance "02" "postgres" \
  "$COMPOSE stop postgres" \
  "$COMPOSE start postgres"

# Scenarios 03 (Horizon outage) and 04 (Soroban RPC timeout) are fully
# self-contained in the driver — just wait for the whole suite to finish.
BACKEND_CID=$($COMPOSE ps -q backend)
log "waiting for the driver to complete all scenarios"
if ! $COMPOSE wait backend; then
  log "chaos suite FAILED (driver exited non-zero)"
fi
driver_exit=$(docker inspect -f '{{.State.ExitCode}}' "$BACKEND_CID" 2>/dev/null || echo 1)

# ── Report ──────────────────────────────────────────────────────────────────
log "driver exit code: $driver_exit"
if [ -f "$RUN_DIR/summary.json" ]; then
  log "chaos summary:"
  cat "$RUN_DIR/summary.json"
  echo
fi

exit "$driver_exit"
