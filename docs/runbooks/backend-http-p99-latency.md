---
title: Backend HTTP P99 High Latency Incident Response
severity: warn
owners:
  - "@oncall-team"
symptoms:
  - "P99 latency exceeding 2 seconds on HTTP routes for >10 minutes"
  - "Client request timeout alerts and slow query warnings"
steps:
  - "Identify affected routes from Prometheus metric `http_request_duration_seconds_bucket`."
  - "Check Postgres database performance and slow query logs for table locks or missing indexes."
  - "Check Redis memory usage and hit/miss ratios."
  - "Scale backend deployment replicas if CPU/Memory utilization is high (`kubectl scale deployment/backend -n stellar-indigopay --replicas=5`)."
verification:
  - "Confirm P99 latency returns below 500ms."
rollback:
  - "Scale back replicas or revert recent configuration changes."
---

# Backend HTTP P99 High Latency Runbook

## Overview
Triggered when 99th percentile HTTP response latency exceeds SLA bounds.

## Investigation Steps
1. Identify high latency routes in Grafana dashboard.
2. Check database connection pool stats and slow query logs.
3. Verify horizontal auto-scaler pod metrics.
