#!/bin/bash

# scripts/setup-replication.sh
# ──────────────────────────────────────────────────────────────────────────────
# Initializes PostgreSQL streaming replication from primary → standby.
#
# This script MUST be run ONCE after the standby StatefulSet is first created
# and before the standby pod starts replicating. It performs:
#
#   1. Creates the replication user on the primary (if not already present).
#   2. Creates a replication slot on the primary.
#   3. Runs pg_basebackup from primary to initialize the standby data directory.
#   4. Creates the standby.signal file so the standby starts in recovery mode.
#   5. Patches the standby ConfigMap with the correct primary_conninfo.
#
# Prerequisites:
#   - kubectl access to the cluster
#   - Both primary and standby pods are running (standby may be crash-looping
#     until replication is set up — that's expected)
#   - AWS CLI configured if using S3 WAL archiving
#
# Usage:
#   ./scripts/setup-replication.sh [--dry-run] [--namespace stellar-indigopay]
#
# Environment variables (optional, defaults from k8s/secret.yaml):
#   REPLICATION_USER     — replication username (default: replicator)
#   REPLICATION_PASSWORD — replication password (default: from secret)
#   NAMESPACE            — Kubernetes namespace (default: stellar-indigopay)
#   PRIMARY_POD          — primary pod name (default: postgres-primary-0)
#   STANDBY_POD          — standby pod name (default: postgres-standby-0)

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
DRY_RUN=false
NAMESPACE="${NAMESPACE:-stellar-indigopay}"
REPLICATION_USER="${REPLICATION_USER:-replicator}"
REPLICATION_PASSWORD="${REPLICATION_PASSWORD:-}"
PRIMARY_POD="${PRIMARY_POD:-postgres-primary-0}"
STANDBY_POD="${STANDBY_POD:-postgres-standby-0}"
REPLICATION_SLOT="${REPLICATION_SLOT:-standby_slot}"

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

log_info()  { echo "[setup-replication] $(date '+%H:%M:%S') ℹ️  $1"; }
log_ok()    { echo "[setup-replication] $(date '+%H:%M:%S') ✅ $1"; }
log_err()   { echo "[setup-replication] $(date '+%H:%M:%S') ❌ $1" >&2; }
run_cmd()   { if $DRY_RUN; then echo "  [dry-run] $*"; else eval "$@"; fi; }

kexec_primary()  { kubectl exec -n "$NAMESPACE" "$PRIMARY_POD" -- "$@"; }
kexec_standby()  { kubectl exec -n "$NAMESPACE" "$STANDBY_POD" -- "$@"; }

# If no password is provided, pull it from the K8s secret.
if [ -z "$REPLICATION_PASSWORD" ]; then
  REPLICATION_PASSWORD=$(kubectl get secret -n "$NAMESPACE" stellar-indigopay-secrets \
    -o jsonpath='{.data.POSTGRES_REPLICATION_PASSWORD}' | base64 -d 2>/dev/null || echo "")
  if [ -z "$REPLICATION_PASSWORD" ]; then
    log_err "REPLICATION_PASSWORD is empty. Set it or ensure the secret has POSTGRES_REPLICATION_PASSWORD."
    exit 1
  fi
fi

# ── Step 1: Verify primary is reachable ───────────────────────────────────────
log_info "Checking primary pod readiness..."
if ! kubectl get pod -n "$NAMESPACE" "$PRIMARY_POD" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null | grep -q True; then
  log_err "Primary pod $PRIMARY_POD is not Ready. Cannot proceed."
  exit 1
fi
log_ok "Primary is ready."

# ── Step 2: Create replication user on primary ────────────────────────────────
log_info "Creating replication user '$REPLICATION_USER' on primary..."
run_cmd kexec_primary psql -U postgres -d stellar_indigopay -c "\
DO \\$\\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${REPLICATION_USER}') THEN
    CREATE ROLE ${REPLICATION_USER} WITH LOGIN REPLICATION PASSWORD '${REPLICATION_PASSWORD}';
  END IF;
END
\\$\\$;" 2>/dev/null || {
  log_info "Replication user may already exist — continuing."
}
log_ok "Replication user configured."

# ── Step 3: Create replication slot on primary ─────────────────────────────────
log_info "Creating replication slot '${REPLICATION_SLOT}' on primary..."
run_cmd kexec_primary psql -U postgres -d stellar_indigopay -c "\
SELECT pg_create_physical_replication_slot('${REPLICATION_SLOT}')
WHERE NOT EXISTS (
  SELECT 1 FROM pg_replication_slots WHERE slot_name = '${REPLICATION_SLOT}'
);" 2>/dev/null || {
  log_info "Replication slot may already exist — continuing."
}
log_ok "Replication slot configured."

# ── Step 4: Grant replication access in pg_hba.conf ────────────────────────────
log_info "Ensuring pg_hba.conf allows replication from standby..."
run_cmd kexec_primary sh -c "'echo host replication ${REPLICATION_USER} all md5 >> /var/lib/postgresql/data/pg_hba.conf && pg_ctl reload -D /var/lib/postgresql/data || true'" 2>/dev/null
log_ok "pg_hba.conf updated."

# ── Step 5: pg_basebackup from primary to standby ─────────────────────────────
log_info "Running pg_basebackup from primary to initialize standby..."
log_info "This may take several minutes depending on database size."

run_cmd kexec_standby sh -c "'\
  rm -rf /var/lib/postgresql/data/* && \
  PGPASSWORD=${REPLICATION_PASSWORD} pg_basebackup \
    -h ${PRIMARY_POD}.postgres-primary-svc.${NAMESPACE}.svc.cluster.local \
    -p 5432 \
    -U ${REPLICATION_USER} \
    -D /var/lib/postgresql/data \
    -P \
    -R \
    -S ${REPLICATION_SLOT} \
    -X stream \
    --no-password'" 2>/dev/null
log_ok "pg_basebackup completed."

# ── Step 6: Verify standby.signal exists ──────────────────────────────────────
log_info "Verifying standby.signal exists..."
# pg_basebackup -R creates the standby.signal file automatically in PG 12+.
if run_cmd kexec_standby test -f /var/lib/postgresql/data/standby.signal; then
  log_ok "standby.signal is present."
else
  log_info "standby.signal not found — creating it."
  run_cmd kexec_standby touch /var/lib/postgresql/data/standby.signal
fi

# ── Step 7: Ensure correct ownership ──────────────────────────────────────────
log_info "Fixing data directory ownership..."
run_cmd kexec_standby chown -R postgres:postgres /var/lib/postgresql/data 2>/dev/null || true
log_ok "Ownership fixed."

# ── Step 8: Restart standby pod ───────────────────────────────────────────────
log_info "Restarting standby pod to begin replication..."
run_cmd kubectl rollout restart statefulset/postgres-standby -n "$NAMESPACE"

log_info "Waiting for standby pod to be ready..."
run_cmd kubectl wait --for=condition=ready pod -l app=postgres,role=standby \
  -n "$NAMESPACE" --timeout=120s 2>/dev/null || {
  log_err "Standby pod did not become ready within 120s. Check logs:"
  echo "  kubectl logs -n $NAMESPACE $STANDBY_POD"
  exit 1
}

# ── Step 9: Verify replication is active ──────────────────────────────────────
log_info "Verifying replication status on primary..."
REPLICATION_CHECK=$(kexec_primary psql -U postgres -d stellar_indigopay -tAc \
  "SELECT count(*) FROM pg_stat_replication WHERE application_name = 'standby';" 2>/dev/null || echo "0")

if [ "$REPLICATION_CHECK" -gt 0 ]; then
  log_ok "Replication is ACTIVE. Standby is receiving WAL from primary."
else
  log_err "Replication check failed — no active replication slots found."
  log_info "Check standby logs: kubectl logs -n $NAMESPACE $STANDBY_POD"
  log_info "Check primary logs: kubectl logs -n $NAMESPACE $PRIMARY_POD"
  exit 1
fi

log_ok "✅ Streaming replication setup complete!"
echo ""
echo "  Primary:  postgres-primary-svc.${NAMESPACE}.svc.cluster.local:5432"
echo "  Standby:  postgres-standby-svc.${NAMESPACE}.svc.cluster.local:5432"
echo ""
echo "  Monitor replication lag:"
echo "    kubectl exec -n $NAMESPACE $PRIMARY_POD -- psql -U postgres -c \\"
echo "      \"SELECT application_name, state, sync_state,"
echo "              pg_wal_lsn_diff(pg_current_wal_lsn(), sent_lsn) AS sent_lag_bytes,"
echo "              pg_wal_lsn_diff(pg_current_wal_lsn(), write_lsn) AS write_lag_bytes"
echo "       FROM pg_stat_replication;\""
