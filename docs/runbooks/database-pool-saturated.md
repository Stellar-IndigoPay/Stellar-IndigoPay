---
title: Database Connection Pool Saturation and Slow Queries Incident Response
severity: page
owners:
  - "@oncall-team"
symptoms:
  - "DBPoolExhausted or DBPoolSaturated alerts active"
  - "Postgres query latency exceeding 500ms on key operations"
steps:
  - "Connect to primary Postgres instance and check active connections via `SELECT * FROM pg_stat_activity WHERE state != 'idle';`."
  - "Identify blocking or unindexed queries."
  - "Increase `DB_POOL_MAX` environment variable if total database capacity permits."
  - "Terminate stuck backend connections if necessary."
verification:
  - "Confirm `db_pool_waiting_count` metric drops to 0."
rollback:
  - "Revert pool size settings to previous values."
---

# Database Connection Pool Saturation Runbook

## Overview
Triggered when all database pool connections are exhausted and backend clients wait.

## Triage
1. Check `pg_stat_activity` for long-running transactions.
2. Review connection pool settings.
