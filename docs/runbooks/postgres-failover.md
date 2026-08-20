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

# Postgres Failover Runbook

## Overview
Triggered during primary database failure or automated failover errors.
