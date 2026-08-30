---
title: Postgres Failover and Primary Unhealthy Incident Response
severity: critical
owners:
  - "@oncall-team"
symptoms:
  - "PostgresPrimaryUnhealthy or PostgresFailoverFailed alert active"
  - "Postgres exporter unreachable or standby promotion failed"
steps:
  - "Check status of Postgres primary pod (`kubectl get pods -n stellar-indigopay -l app=postgres`)."
  - "If primary crashed, check failover job status (`kubectl get jobs -n stellar-indigopay -l app=postgres-failover`)."
  - "Follow manual failover procedures documented in `docs/restore-runbook.md` if automated job fails."
  - "Update ConfigMap `stellar-indigopay-config` with new primary host and restart backend pods."
verification:
  - "Verify backend connects to new primary and readiness probe succeeds."
rollback:
  - "Re-sync old primary host and verify replication lag before failing back."
---

# Runbook: PostgreSQL Automated Failover

Part of issue **#1100 — Workstream 1**: real-time, health-check-driven promotion
with Kubernetes-Lease-based split-brain prevention and Prometheus alerting.

## Overview

In normal operation the platform has:

- **postgres-primary** — a `StatefulSet` accepting reads and writes.
- **postgres-standby** — a warm, read-only standby streaming WAL from the primary
  in near-real-time (`synchronous_commit = remote_apply`, so every acknowledged
  write is already applied on the standby).

A **postgres-healthcheck daemon** (`scripts/postgres-healthcheck-daemon.js`) runs
as a sidecar on (at minimum) the standby. It health-checks the primary every 5 s
via `pg_isready`. After 3 consecutive failures (~15 s) it:

1. Attempts to acquire the Kubernetes Lease `postgres-primary-lock`
   (compare-and-swap on `holderIdentity` / `renewTime`) — **only one node can
   hold it**, which is what makes split-brain (two primaries accepting writes)
   impossible.
2. On winning the Lease it creates the `postgres-failover` **Job**, which:
   - verifies the standby is running,
   - runs `pg_ctl promote` on the standby,
   - patches the `postgres-svc` / `postgres-primary-svc` Services to point at
     the new primary,
   - updates the `stellar-indigopay-config` ConfigMap,
   - rolling-restarts the backend and waits for readiness,
   - increments `postgres_failover_total` and notifies Slack.
3. A node that **loses** the Lease logs a warning and backs off, never touching
   Postgres.

> Because `synchronous_commit = remote_apply` is configured on the primary, every
> transaction acknowledged before the crash is already durable on the standby —
> the failover has **zero write loss**.

## When to use this runbook

- You receive a **PostgresFailoverHappened** (critical) alert.
- You received a **PostgresFailoverSucceeded** (warn) alert and need to follow
  up.
- `postgres-primary` pod is stuck in `CrashLoopBackOff` / `NotReady`.

## Step 1 — Confirm what failover did

```bash
kubectl get pods -n stellar-indigopay -l app=postgres -o wide
kubectl get leases -n stellar-indigopay postgres-primary-lock -o yaml
```

Expected: `postgres-standby-0` is `Running` and no longer in recovery;
`postgres-primary-0` is the one that is down/absent. The Lease `holderIdentity`
should name the health-check on the standby.

## Step 2 — Verify the new primary is serving writes

```bash
kubectl exec -n stellar-indigopay postgres-standby-0 -- \
  psql -U postgres -tAc "SELECT pg_is_in_recovery();"   # expect: f

kubectl exec -n stellar-indigopay postgres-standby-0 -- \
  psql -U postgres -tAc "SELECT now();"
```

## Step 3 — Verify zero write loss

Locate the old primary's `pg_xact`/timeline marker and the new primary's.

```bash
# Confirm replication timeline advanced and no acknowledged LSN regressed.
kubectl exec -n stellar-indigopay postgres-standby-0 -- \
  psql -U postgres -tAc "SELECT timeline_id FROM pg_control_checkpoint();"
kubectl logs -n stellar-indigopay -l app=postgres --tail=50 | grep -i promote
```

The `synchronous_commit = remote_apply` setting means the promotion timeline
begins after every acknowledged commit, so committed data is present.

## Step 4 — Confirm services route to the new primary

```bash
kubectl get endpoints postgres-svc -n stellar-indigopay
kubectl get endpoints postgres-primary-svc -n stellar-indigopay
```

Both should list `postgres-standby-0`'s pod IP.

## Step 5 — Check Prometheus / Grafana

- `postgres_failover_total` should have incremented (all outcomes: initiated /
  succeeded).
- Confirm the **PostgresFailoverHappened** alert resolves after the new primary
  reports healthy.

## Step 6 — Rescue and re-join the old primary

Once the old primary comes back it must **never** be re-added as a second
primary. Reconfigure it as a standby using `pg_rewind`:

```bash
# Verify the old node is truly a standby candidate first:
kubectl exec -n stellar-indigopay postgres-primary-0 -- \
  psql -U postgres -tAc "SELECT pg_is_in_recovery();"

# Rebase the old data directory onto the new primary's timeline.
kubectl exec -n stellar-indigopay postgres-primary-0 -- \
  pg_rewind --target-pgdata /var/lib/postgresql/data \
            --source-server "host=postgres-standby-svc port=5432 user=postgres dbname=postgres"
```

> **Important:** never start the old primary while the new primary is live.
> Always `pg_rewind` and place it in standby mode first, or you will create the
> exact split-brain this Lease was built to prevent.

Then re-run `scripts/setup-replication.sh` to restore streaming from the new
primary to the old instance.

## Step 7 — Failback (optional, after operations stabilize)

To move the primary back to its original node, follow the same sequence with
roles swapped, again guarded by the Lease. The Lease automatically transfers
because the current primary renews it continuously; a standby only promotes
after winning it from the current holder.

## Split-brain test / drill

To validate the guard:

```bash
# Simulate two nodes trying to promote at once. Only one will win the Lease.
kubectl exec -n stellar-indigopay postgres-standby-0 -- \
  node /scripts/postgres-healthcheck-daemon.js  # (as part of the drill)
```

Only the node that logs "acquired primary lock" should proceed; the other must
log "split-brain prevention: lost lease, backing off".

## Cleanup

- Delete any completed failover Jobs:
  ```bash
  kubectl delete jobs -n stellar-indigopay -l app=postgres-failover
  ```
- Confirm the ConfigMap `stellar-indigopay-config` has the correct
  `POSTGRES_PRIMARY_HOST`.
- Update `docs/disaster-recovery.md` with the actual incident if it revealed a
  gap.
