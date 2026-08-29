# Worker Disruption Runbook

## Overview
This runbook covers how the worker pods (indexer, recurring keeper, guardian, webhook dispatcher, digest, outbox dispatcher) handle involuntary and voluntary disruptions (e.g. node drain, spot eviction, rollout).

## Exclusive / Lease-holding workers
- **Workers**: `indexer`, `recurring-keeper`, `guardian`
- **PDB Configuration**: `minAvailable: 1`
- **Behavior**: These workers are singletons or hold specific leases. During a rollout or node drain, the `preStop` hook will pause the container for 15 seconds, allowing it to gracefully save state, release DB locks, and persist cursors. The PDB guarantees that at least one pod is available at all times, preventing complete outages of these singletons during voluntary maintenance.

## Horizontally Scaled Queue Consumers
- **Workers**: `webhook-dispatcher`, `digest`, `outbox-dispatcher`
- **PDB Configuration**: `maxUnavailable: 1` (or 25%)
- **Behavior**: These workers pull jobs from `pg-boss` queues. When a SIGTERM is sent, the `preStop` hook pauses termination, giving the process a 15-30s window to finish executing in-flight jobs. If the job does not complete in time, `pg-boss` handles the retry automatically via its dead-letter / retry logic when the job times out and is reclaimed. The `maxUnavailable` PDB allows rollouts and node scaling to proceed rapidly.

## Node Drain & Spot Evictions
The cluster autoscaler node-replacement events or manual `kubectl drain` commands will respect the configured PDBs. For singleton workers, a replacement pod must reach readiness before the old pod is evicted.

## Recovery Mechanisms
- **DLQ Replay**: For failed queue jobs that exceed their retry count, administrators can replay the dead-letter queue via the admin dashboard (e.g., webhook replay).
- **Lease Expiry**: If a singleton worker is forcefully killed (OOMKilled or node crash) without running the `preStop` hook, its lease will expire based on the DB heartbeat timeout, and the new pod will claim it.
