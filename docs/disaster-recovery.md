# Disaster Recovery Plan

This document defines recovery targets, failure modes, and the runbooks
the on-call team should follow. The goal is to make the recovery path
explicit and rehearsed, not improvised.

## Recovery Targets

| Tier | Service                 | RTO (down) | RPO (data loss)                 | Strategy                                                                     |
| ---- | ----------------------- | ---------- | ------------------------------- | ---------------------------------------------------------------------------- |
| 1    | API + web               | 5 min      | 0                               | Multi-replica deployment + HPA, no in-flight request loss on rolling restart |
| 1    | Stellar indexer         | 5 min      | 0 (at-rest), 5 min (in-stream)  | Restart from `cursor=now` (in-memory; gap-fill job runs after restart)       |
| 2    | Postgres                | 2 min      | 5 min                           | WAL archiving to S3 every 5 min; base backup nightly; warm standby with automated failover (30 s detection + 60 s promotion) |
| 2    | Redis cache             | 1 min      | 0 (cache rebuild on first read) | No persistence; treated as ephemeral                                         |
| 3    | Push notification queue | 1 hour     | All un-pushed notifications     | pg-boss backed; rows persist in `webhook_deliveries` until ack               |

RTO/RPO are reviewed quarterly. They are not free — RPO 0 for tier 1
requires synchronous multi-region replication, which we don't run
yet. The current single-region posture is documented in
`docs/disaster-recovery.md` and the multi-region upgrade is in the
roadmap.

## Failure Modes

### Pod crash

- **Detection**: readiness probe fails, kube-proxy removes the pod
  from the service endpoints.
- **Recovery**: kubelet restarts the pod; HPA replaces it if it
  fails repeatedly. No operator action needed.
- **RTO**: < 30s.

### Node failure

- **Detection**: kube-controller-manager marks the node `NotReady`
  after the node-monitor-grace-period (default 50s).
- **Recovery**: pods are evicted, scheduled on healthy nodes, HPA
  ensures minimum replica count.
- **RTO**: < 2 min.

### Database corruption (single-writer pod)

- **Detection**: readiness probe returns 503 (`db_pool_waiting > 0`
  alert).
- **Recovery**: restore from latest S3 backup; see `restore runbook`.
- **RTO**: 30 min (assumes backup download + replay).
- **RPO**: up to 5 min (last WAL archive).

### Database region failure

- **Detection**: postgres-healthcheck sidecar detects primary down
  within 30 s; Prometheus `PostgresPrimaryUnhealthy` alert fires after
  2 min.
- **Recovery**: automated failover promotes standby (see
  `k8s/postgres-failover-job.yaml`). Standby becomes writable within
  60 s; backend rolling-restarts and reconnects. If automated failover
  fails, `PostgresFailoverFailed` alerts on-call for manual failover
  per `docs/restore-runbook.md`.
- **RTO**: < 2 min (automated).
- **RPO**: < 5 min (WAL streaming + archive lag).

### Secret compromise

- **Detection**: gitleaks CI alert, anomalous access in CloudTrail, or
  partner notification.
- **Recovery**: rotate the affected secret in AWS Secrets Manager;
  external-secrets-operator will refresh the K8s Secret within
  `refreshInterval` (default 1h). Trigger an immediate refresh with
  `kubectl annotate externalsecret stellar-indigopay-secrets force-sync=$(date +%s)`.
- **RTO**: < 5 min for credential rotation; < 1h for the operator
  to refresh.

### Webhook receiver compromise

- **Detection**: partner notification or anomalous delivery pattern.
- **Recovery**: rotate `webhook_secret` per project; receivers must
  re-fetch the new value and update their verifier.
- **RTO**: per-receiver (typically < 1h).## Multi-Region Strategy (Implemented)

### Architecture

Stellar-IndigoPay implements a warm PostgreSQL standby for multi-region
disaster recovery using PostgreSQL native streaming replication with
automated failover orchestration:

```
┌──────────────────────────────────────────────────────────────────┐
│  Region A (us-east-1)                   Region B (us-west-2)    │
│  ┌──────────────────┐                  ┌──────────────────────┐ │
│  │ postgres-primary  │  streaming WAL   │  postgres-standby    │ │
│  │ (read/write)      │ ═══════════════► │  (hot_standby=on)    │ │
│  │ + healthcheck     │                  │  (read-only)         │ │
│  │   sidecar         │                  │                      │ │
│  └────────┬───────────┘                  └──────────────────────┘ │
│           │ WAL archive (every 5 min)                             │
│           ▼                                                       │
│  ┌─────────────────┐                                              │
│  │  S3 (cross-      │◄──────── WAL restore (fallback) ────────────│
│  │  region repl.)   │                                              │
│  └─────────────────┘                                              │
│                                                                    │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  Automated Failover Pipeline (when primary is down >30 s)   │ │
│  │  1. healthcheck sidecar → creates failover Job via K8s API   │ │
│  │  2. failover Job → pg_ctl promote on standby                │ │
│  │  3. Patch Services → redirect postgres-svc to new primary    │ │
│  │  4. Rolling restart backend → pods reconnect                │ │
│  │  5. Slack notification → on-call informed                   │ │
│  │  RTO: < 2 min   RPO: < 5 min                                │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### Implementation Details

1. **Streaming Replication**: The primary streams WAL to the standby via
   a replication slot (`standby_slot`). The standby stays in continuous
   recovery mode with `hot_standby=on`, allowing read-only queries for
   verification.

2. **WAL Archiving**: WAL segments are archived to S3 every 5 minutes
   as a fallback. If the standby falls behind on streaming, it fetches
   WAL from S3 via `restore_command`.

3. **Initial Setup**: Run `scripts/setup-replication.sh` after deploying
   the standby StatefulSet. This script:
   - Creates the replication user and slot on the primary
   - Runs `pg_basebackup` to initialize the standby
   - Verifies replication is active

4. **Failover Procedure** (see `docs/restore-runbook.md` and `k8s/postgres-failover-job.yaml`):

   **Automated** (when `postgres.failover.enabled` is `true`):
   - The healthcheck sidecar detects primary failure within 30 s
   - Creates the failover Job automatically
   - Services are re-pointed and backend restarted
   - Total RTO: < 2 min

   **Manual override** (if automated failover fails):
   ```bash
   # 1. Verify primary is unreachable
   kubectl exec -n stellar-indigopay postgres-standby-0 -- pg_isready

   # 2. Promote standby to primary
   kubectl exec -n stellar-indigopay postgres-standby-0 -- pg_ctl promote

   # 3. Route services to new primary
   kubectl patch svc postgres-svc -n stellar-indigopay \
     --type=json -p='[{"op":"replace","path":"/spec/selector/role","value":"standby"}]'
   kubectl patch svc postgres-primary-svc -n stellar-indigopay \
     --type=json -p='[{"op":"replace","path":"/spec/selector/role","value":"standby"}]'

   # 4. Update DATABASE_URL in AWS Secrets Manager to point at standby
   aws secretsmanager update-secret --secret-id stellar-indigopay/prod \
     --secret-string '{"database_url":"postgres://...@postgres-standby-svc:5432/..."}'

   # 5. Force refresh the external secret
   kubectl annotate externalsecret stellar-indigopay-secrets \
     force-sync="$(date +%s)" -n stellar-indigopay

   # 6. Restart backend pods
   kubectl rollout restart deployment/backend -n stellar-indigopay
   ```

5. **Monitoring**:
   - `PgReplicationLag` alert fires when replication lag > 60s
   - `PgReplicationDown` alert fires when no active replication slots exist
   - `PgStandbyNotReady` alert fires when the standby pod is unhealthy
   - All alerts route to PagerDuty (`severity: page`)

6. **Node Affinity**: The standby uses pod anti-affinity to ensure it
   schedules on a different availability zone than the primary, providing
   zone-level fault tolerance.

## Monitoring the DR Plan
The on-call alert pipeline includes:

- Backup success (last 36h) — `BackupMissed` alert (see alert-rules-routing.yml).
- Restore drill success (last 30 days) — `RestoreDrillFailed` alert.
- Replication lag — `PgReplicationLag` alert at 60s.
- Standby health — `PgStandbyNotReady` alert.

See `monitoring/alert-rules.yml` for the current rules and
`.github/workflows/restore-drill.yml` for the drill workflow.
