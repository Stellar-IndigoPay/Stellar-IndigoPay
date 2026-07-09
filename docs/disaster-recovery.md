# Disaster Recovery Plan

This document defines recovery targets, failure modes, and the runbooks
the on-call team should follow. The goal is to make the recovery path
explicit and rehearsed, not improvised.

## Recovery Targets

| Tier | Service | RTO (down) | RPO (data loss) | Strategy |
|------|---------|-----------|----------------|----------|
| 1 | API + web | 5 min | 0 | Multi-replica deployment + HPA, no in-flight request loss on rolling restart |
| 1 | Stellar indexer | 5 min | 0 (at-rest), 5 min (in-stream) | Restart from `cursor=now` (in-memory; gap-fill job runs after restart) |
| 2 | Postgres | 30 min | 5 min | WAL archiving to S3 every 5 min; base backup nightly; restore drill monthly |
| 2 | Redis cache | 1 min | 0 (cache rebuild on first read) | No persistence; treated as ephemeral |
| 3 | Push notification queue | 1 hour | All un-pushed notifications | pg-boss backed; rows persist in `webhook_deliveries` until ack |

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
- **Detection**: cluster API unreachable from primary region.
- **Recovery**: fail over DNS / Load Balancer to a warm standby in a
  second region. **Not automated yet** — see roadmap.
- **RTO**: 30 min manual.
- **RPO**: 1 min (replication lag).

### Secret compromise
- **Detection**: gitleaks CI alert, anomalous access in CloudTrail, or
  partner notification.
- **Recovery**: rotate the affected secret in AWS Secrets Manager;
  external-secrets-operator will refresh the K8s Secret within
  `refreshInterval` (default 1h). Trigger an immediate refresh with
  `kubectl annotate externalsecret indigopay-secrets force-sync=$(date +%s)`.
- **RTO**: < 5 min for credential rotation; < 1h for the operator
  to refresh.

### Webhook receiver compromise
- **Detection**: partner notification or anomalous delivery pattern.
- **Recovery**: rotate `webhook_secret` per project; receivers must
  re-fetch the new value and update their verifier.
- **RTO**: per-receiver (typically < 1h).

## Multi-Region Strategy (Roadmap)

Single-region currently. The next DR step is:

1. Provision a warm Postgres standby in a second region (e.g.
   `us-west-2`) via managed Postgres replication.
2. Add a Route 53 / Cloud DNS health-check that flips the API
   origin to the standby when the primary fails its health check.
3. Frontend is replicated by the CDN origin; no application change
   needed beyond the LB swap.
4. Backups replicate cross-region via S3 cross-region replication.

This is targeted for the next release; until then, single-region is
the documented posture and the runbook above applies.

## Monitoring the DR Plan

The on-call alert pipeline must include:
- Backup success (last 24h) — `database_backup_success` alert.
- Restore drill success (last 30 days) — checked manually in the
  on-call review.
- Cross-region replication lag (when enabled) — `pg_replication_lag`
  alert at 60s.

See `monitoring/alert-rules.yml` for the current rules and
`.github/workflows/restore-drill.yml` for the drill workflow.
