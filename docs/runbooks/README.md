# Incident Response Runbook Index

This directory contains versioned, actionable runbooks for all Prometheus alert rules in Stellar-IndigoPay.

> [!IMPORTANT]
> **Runbook-as-Code Policy**: Every alert rule in `monitoring/` MUST have a `runbook` annotation pointing to an existing document in `docs/runbooks/`. CI automatically validates this linkage on every PR.

## Alert Rules & Runbook Matrix

| Alert Name | Severity | Group | Summary | Runbook Document |
| :--- | :--- | :--- | :--- | :--- |
| `PostgresFailoverHappened` | `critical` | `stellar-indigopay-postgres-failover-info` | Postgres failover triggered — primary unavailable, standby promoted | [Postgres Failover and Primary Unhealthy Incident Response](../../docs/runbooks/postgres-failover.md) |
| `PostgresFailoverInitiated` | `critical` | `stellar-indigopay-backend-availability` | Postgres automatic failover has been initiated | [Postgres Failover and Primary Unhealthy Incident Response](../../docs/runbooks/postgres-failover.md) |
| `PostgresPrimaryUnhealthy` | `critical` | `stellar-indigopay-postgres-failover-info` | Postgres primary exporter is down | [Postgres Failover and Primary Unhealthy Incident Response](../../docs/runbooks/postgres-failover.md) |
| `RestoreDrillChecksumMismatch` | `critical` | `stellar-indigopay-backend-backup` | Restore drill checksum mismatch detected | [Database Backup Failure and Verification Incident Response](../../docs/runbooks/database-backup-verification.md) |
| `RestoreDrillFailed` | `critical` | `stellar-indigopay-backend-backup` | Restore drill failed — backup may be unrecoverable | [Database Backup Failure and Verification Incident Response](../../docs/runbooks/database-backup-verification.md) |
| `ArgoCDAppDegraded` | `page` | `stellar-indigopay-gitops-drift` | ArgoCD application {{ $labels.name }} health is Degraded | [ArgoCD GitOps Sync Drift and Application Health Incident Response](../../docs/runbooks/gitops-argocd-drift.md) |
| `ArgoCDAppOutOfSync` | `page` | `stellar-indigopay-gitops-drift` | ArgoCD application {{ $labels.name }} is OutOfSync | [ArgoCD GitOps Sync Drift and Application Health Incident Response](../../docs/runbooks/gitops-argocd-drift.md) |
| `BackendDown` | `page` | `stellar-indigopay-backend-availability` | Backend readiness has failed > 5 times in 5m | [Backend HTTP 5xx Error Rate and Availability Incident Response](../../docs/runbooks/backend-http-5xx-rate.md) |
| `BackendHigh5xxRate` | `page` | `stellar-indigopay-backend-http` | Backend 5xx rate above 5% for 5m | [Backend HTTP 5xx Error Rate and Availability Incident Response](../../docs/runbooks/backend-http-5xx-rate.md) |
| `BackupMissed` | `page` | `stellar-indigopay-backend-availability` | No successful Postgres backup in the last 36h | [Database Backup Failure and Verification Incident Response](../../docs/runbooks/database-backup-verification.md) |
| `BackupVerificationFailed` | `page` | `stellar-indigopay-backend-backup` | Database backup verification failed | [Database Backup Failure and Verification Incident Response](../../docs/runbooks/database-backup-verification.md) |
| `DBPoolExhausted` | `page` | `stellar-indigopay-backend-database` | Database connection pool exhausted for >10 minutes | [Database Connection Pool Saturation and Slow Queries Incident Response](../../docs/runbooks/database-pool-saturated.md) |
| `DonationsHighBurnRate1h` | `page` | `indigopay-slo-burn` | Donation API burning error budget at 2%/1h (>14.4x burn rate) | [Backend HTTP 5xx Error Rate and Availability Incident Response](../../docs/runbooks/backend-http-5xx-rate.md) |
| `DonationsHighBurnRate6h` | `page` | `indigopay-slo-burn` | Donation API burning error budget at 5%/6h (>6x burn rate) | [Backend HTTP 5xx Error Rate and Availability Incident Response](../../docs/runbooks/backend-http-5xx-rate.md) |
| `IndexerLagHigh` | `page` | `stellar-indigopay-backend-readiness` | Indexer lag is >500 ledgers (~42 minutes behind) | [Horizon Indexer Lag and Worker Freshness Incident Response](../../docs/runbooks/indexer-lag.md) |
| `IndexerStreamDown` | `page` | `stellar-indigopay-backend-readiness` | Indexer stream appears down — no reconnects and positive lag | [Horizon Indexer Lag and Worker Freshness Incident Response](../../docs/runbooks/indexer-lag.md) |
| `OracleStale` | `page` | `stellar-indigopay-backend-readiness` | Oracle price is stale (>15 min since last update) | [Horizon Indexer Lag and Worker Freshness Incident Response](../../docs/runbooks/indexer-lag.md) |
| `PostgresFailoverFailed` | `page` | `stellar-indigopay-backend-availability` | Postgres automatic failover FAILED — manual intervention required | [Postgres Failover and Primary Unhealthy Incident Response](../../docs/runbooks/postgres-failover.md) |
| `ProjectsHighBurnRate1h` | `page` | `indigopay-slo-burn` | Project listing API burning error budget at 2%/1h (>14.4x burn rate) | [Backend HTTP 5xx Error Rate and Availability Incident Response](../../docs/runbooks/backend-http-5xx-rate.md) |
| `ProjectsHighBurnRate6h` | `page` | `indigopay-slo-burn` | Project listing API burning error budget at 5%/6h (>6x burn rate) | [Backend HTTP 5xx Error Rate and Availability Incident Response](../../docs/runbooks/backend-http-5xx-rate.md) |
| `ReadinessProbeFailing` | `page` | `stellar-indigopay-backend-readiness` | Backend readiness has been failing for 3m | [Horizon Indexer Lag and Worker Freshness Incident Response](../../docs/runbooks/indexer-lag.md) |
| `RestoreDrillFailed` | `page` | `stellar-indigopay-backend-availability` | Last monthly restore drill failed | [Database Backup Failure and Verification Incident Response](../../docs/runbooks/database-backup-verification.md) |
| `SecretRotationFailed` | `page` | `stellar-indigopay-secret-rotation` | Secret rotation failed or was rolled back in the last hour | [Automated Secret Rotation Failure or Overdue Incident Response](../../docs/runbooks/secret-rotation.md) |
| `SyntheticDonationCheckFailing` | `page` | `stellar-indigopay-synthetic-monitoring` | Synthetic end-to-end donation check has failed at least twice in the last 15 minutes | [Synthetic Monitor and Transaction Failure Incident Response](../../docs/runbooks/synthetic-monitor-failure.md) |
| `WorkerFreshness` | `page` | `stellar-indigopay-backend-readiness` | Worker freshness alert (>5 min since last heartbeat) | [Horizon Indexer Lag and Worker Freshness Incident Response](../../docs/runbooks/indexer-lag.md) |
| `BackendHighP99Latency` | `warn` | `stellar-indigopay-backend-http` | Backend p99 latency above 2s for 10m on {{ $labels.route }} | [Backend HTTP P99 High Latency Incident Response](../../docs/runbooks/backend-http-p99-latency.md) |
| `BackupStalled` | `warn` | `stellar-indigopay-backend-backup` | No successful database backup in the last 48h | [Database Backup Failure and Verification Incident Response](../../docs/runbooks/database-backup-verification.md) |
| `DBPoolSaturated` | `warn` | `stellar-indigopay-backend-database` | Database connection pool has waiting clients | [Database Connection Pool Saturation and Slow Queries Incident Response](../../docs/runbooks/database-pool-saturated.md) |
| `DbQuerySlow` | `warn` | `stellar-indigopay-backend-database` | Postgres p99 query latency above 500ms for 10m on op={{ $labels.operation }} | [Database Connection Pool Saturation and Slow Queries Incident Response](../../docs/runbooks/database-pool-saturated.md) |
| `DonationsHighBurnRate3d` | `warn` | `indigopay-slo-burn` | Donation API burning error budget at 10%/3d (>1x burn rate) | [Backend HTTP 5xx Error Rate and Availability Incident Response](../../docs/runbooks/backend-http-5xx-rate.md) |
| `HighRateLimitExhaustion` | `warn` | `stellar-indigopay-rate-limit` | More than 10% of requests are being rate-limited | [Rate Limit Exhaustion and Spike Incident Response](../../docs/runbooks/rate-limit-exhaustion.md) |
| `IndexerLagWarning` | `warn` | `stellar-indigopay-backend-readiness` | Indexer lag is >50 ledgers | [Horizon Indexer Lag and Worker Freshness Incident Response](../../docs/runbooks/indexer-lag.md) |
| `PerEndpointRateLimitSpike` | `warn` | `stellar-indigopay-rate-limit` | {{ $labels.endpoint }} is being rate-limited heavily (>5/s for 5m) | [Rate Limit Exhaustion and Spike Incident Response](../../docs/runbooks/rate-limit-exhaustion.md) |
| `PostgresFailoverSucceeded` | `warn` | `stellar-indigopay-postgres-failover-info` | Postgres failover completed successfully | [Postgres Failover and Primary Unhealthy Incident Response](../../docs/runbooks/postgres-failover.md) |
| `PostgresLeaseContention` | `warn` | `stellar-indigopay-postgres-failover-info` | Postgres primary Lease has no active holder | [Postgres Failover and Primary Unhealthy Incident Response](../../docs/runbooks/postgres-failover.md) |
| `ProjectsHighBurnRate3d` | `warn` | `indigopay-slo-burn` | Project listing API burning error budget at 10%/3d (>1x burn rate) | [Backend HTTP 5xx Error Rate and Availability Incident Response](../../docs/runbooks/backend-http-5xx-rate.md) |
| `QueueDepthHigh` | `warn` | `stellar-indigopay-backend-readiness` | Queue failed jobs count is high (>100) for 10m on {{ $labels.queue }} | [Horizon Indexer Lag and Worker Freshness Incident Response](../../docs/runbooks/indexer-lag.md) |
| `RedisSentinelFailover` | `warn` | `stellar-indigopay-backend-availability` | Redis Sentinel failover / reconnection detected | [Postgres Failover and Primary Unhealthy Incident Response](../../docs/runbooks/postgres-failover.md) |
| `SecretRotationOverdue` | `warn` | `stellar-indigopay-secret-rotation` | No successful secret rotation in > 95 days | [Automated Secret Rotation Failure or Overdue Incident Response](../../docs/runbooks/secret-rotation.md) |
| `SecretRotationStuck` | `warn` | `stellar-indigopay-secret-rotation` | Secret rotation has been in_progress for > 30 minutes | [Automated Secret Rotation Failure or Overdue Incident Response](../../docs/runbooks/secret-rotation.md) |
| `SyntheticDonationCheckSlow` | `warn` | `stellar-indigopay-synthetic-monitoring` | Synthetic donation check p99 duration is above 30s | [Synthetic Monitor and Transaction Failure Incident Response](../../docs/runbooks/synthetic-monitor-failure.md) |
| `SyntheticMonitorSilent` | `warn` | `stellar-indigopay-synthetic-monitoring` | Synthetic monitor has not emitted a heartbeat in >15 minutes | [Synthetic Monitor and Transaction Failure Incident Response](../../docs/runbooks/synthetic-monitor-failure.md) |
| `TokenBucketExhausted` | `warn` | `stellar-indigopay-rate-limit` | Token bucket empty on {{ $labels.endpoint }} for 5m | [Rate Limit Exhaustion and Spike Incident Response](../../docs/runbooks/rate-limit-exhaustion.md) |


*Generated automatically by `scripts/generate-runbook-index.js`.*
