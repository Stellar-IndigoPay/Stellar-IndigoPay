# Postgres Restore Runbook

This runbook covers restoring the production Postgres database from
the latest S3 backup and performing a manual failover if the automated
system fails. Use it during a real incident after the on-call has
confirmed the database is corrupt or the data is unrecoverable from
the running cluster.

## Automated Failover (Primary)

When `postgres.failover.enabled` is `true` in the Helm values, the
primary StatefulSet includes a `postgres-healthcheck` sidecar that
continuously polls `pg_isready` every 5 seconds. After 6 consecutive
failures (30 seconds), the sidecar:

1. Creates a `postgres-failover` Job via the Kubernetes API
2. The Job promotes the standby (`pg_ctl promote`)
3. Patches `postgres-svc` and `postgres-primary-svc` Service selectors
   to point at the new primary (standby pod)
4. Updates the `stellar-indigopay-config` ConfigMap with the new
   `POSTGRES_PRIMARY_HOST`
5. Triggers a rolling restart of the `backend` Deployment
6. Sends a Slack notification (if `SLACK_WEBHOOK_URL` is set)

Alerts that fire during automated failover:
- `PostgresFailoverInitiated` (severity: critical) — failover started
- `PostgresFailoverSucceeded` (severity: warn) — failover completed
- `PostgresFailoverFailed` (severity: page) — failover failed;
  proceed to Manual Failover below
- `PostgresPrimaryUnhealthy` (severity: critical) — primary exporter
  is down; may precede automated failover

### Checking failover status

```bash
# List recent failover Jobs
kubectl get jobs -n stellar-indigopay -l app=postgres-failover

# View failover logs
kubectl logs -n stellar-indigopay -l app=postgres-failover --tail=100

# Verify new primary
kubectl exec -n stellar-indigopay postgres-standby-0 -- \
  psql -U postgres -tAc "SELECT pg_is_in_recovery();"
# Should return 'f' (not in recovery = primary)

# Check Service routing
kubectl get svc postgres-svc -n stellar-indigopay \
  -o jsonpath='{.spec.selector.role}'
# Should return 'standby' after successful failover
```

### Manual failover override

If the automated system fails or you need to trigger failover manually:

```bash
# Create the failover Job manually
kubectl create job --from=cronjob/postgres-failover-drill \
  postgres-failover-manual-$(date +%s) -n stellar-indigopay

# Or execute steps directly:
kubectl exec -n stellar-indigopay postgres-standby-0 -- \
  pg_ctl promote -D /var/lib/postgresql/data
kubectl patch svc postgres-svc -n stellar-indigopay \
  --type=json -p='[{"op":"replace","path":"/spec/selector/role","value":"standby"}]'
kubectl patch svc postgres-primary-svc -n stellar-indigopay \
  --type=json -p='[{"op":"replace","path":"/spec/selector/role","value":"standby"}]'
kubectl rollout restart deployment/backend -n stellar-indigopay
```

## Pre-flight

1. Confirm the incident: a healthy cluster returns 200 on
   `/api/readyz` and the `db_pool_waiting_count` gauge is 0. If
   not, the issue is elsewhere — do not proceed.
2. Identify the restore target time. Aim for the most recent WAL
   archive. Confirm it exists:
   ```bash
   aws s3 ls s3://${S3_BUCKET}/backups/ --recursive | tail -20
   ```
3. Announce in the on-call channel: "Beginning restore from
   ${TIMESTAMP}, downtime expected 30-60 min."

## Provision a fresh database

1. Spin up a clean Postgres pod (or RDS instance) at the version
   matching production (`postgres:16-alpine` for k8s, the matching
   engine version for RDS). DO NOT touch the broken pod.
2. Restore the base backup:
   ```bash
   aws s3 cp s3://${S3_BUCKET}/backups/stellar_indigopay_backup_${TIMESTAMP}.sql.gz /tmp/
   gunzip /tmp/stellar_indigopay_backup_${TIMESTAMP}.sql.gz
   psql "postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${NEW_HOST}:5432/postgres" \
     -f /tmp/indigopay_backup_${TIMESTAMP}.sql
   ```
3. Verify the base restore:
   ```bash
   psql "postgres://...@${NEW_HOST}:5432/indigopay" \
     -c "SELECT count(*) FROM donations; SELECT count(*) FROM projects;"
   ```
4. Apply WAL archives from S3 (point-in-time recovery). The exact
   `restore_command` is set in `postgresql.conf`:
   ```ini
   restore_command = 'aws s3 cp s3://${S3_BUCKET}/wal/%f %p'
   recovery_target_time = '2026-07-09 10:30:00 UTC'
   recovery_target_action = 'promote'
   ```
5. `pg_ctl promote` (or `SELECT pg_promote();`) when replay catches
   up to the target time.

## Cutover

1. Stop the backend deployment:
   ```bash
   kubectl scale deploy/backend --replicas=0 -n stellar-indigopay
   ```
2. Update the `DATABASE_URL` secret in AWS Secrets Manager to point
   at the new host.
3. Restart the backend:
   ```bash
   kubectl scale deploy/backend --replicas=2 -n stellar-indigopay
   ```
4. Watch the readiness probe:
   ```bash
   kubectl logs -n stellar-indigopay -l app=backend -c backend --tail=200 -f
   ```
5. Smoke test: `curl https://api.stellarindigopay.app/api/health` should
   return 200; `/api/projects` should return the expected list.

## Post-restore

1. Re-enable scheduled backups (the restored DB has no cron).
2. Verify webhook delivery resume: check `webhook_deliveries WHERE
status='pending' AND next_attempt_at <= NOW()`.
3. Open a post-incident review within 48 hours.
4. Update RTO/RPO numbers in `docs/disaster-recovery.md` if the
   incident was longer/shorter than the target.

## Backup Verification

Each nightly backup is automatically verified by the
`scripts/verify-backup.js` script in the database-backup workflow
(`.github/workflows/database-backup.yml`). The verification runs
immediately after the backup is created and checks:

- File integrity (existence, non-zero size, SHA-256 checksum)
- Restore into a temporary Postgres container
- Existence of all critical tables (`projects`, `donations`,
  `profiles`, `verification_requests`, `donation_matches`)
- Minimum row counts (`projects ≥ 1`, `donations ≥ 0`,
  `profiles ≥ 0`)
- Foreign key consistency (zero orphaned donations)

A `BackupVerificationFailed` alert fires via Prometheus when
verification fails, routed to PagerDuty (`severity: page`).
To manually verify a specific backup:

```bash
node backend/scripts/verify-backup.js --backup /path/to/backup.sql
node backend/scripts/verify-backup.js --backup /path/to/backup.sql.gz
```

The script outputs a JSON report with pass/fail per check and
exits 0 on success or 1 on any failing check.

## Monthly Dry Run

The `restore-drill` workflow under `.github/workflows/restore-drill.yml`
runs this runbook on a cron (1st of every month) against an
ephemeral Postgres pod. Drill failures page on-call.
