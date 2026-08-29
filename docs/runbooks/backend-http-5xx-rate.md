---
title: Backend HTTP 5xx Error Rate and Availability Incident Response
severity: page
owners:
  - "@oncall-team"
symptoms:
  - "Increased HTTP 5xx responses (>5%) across backend endpoints"
  - "Readiness probe failures on /api/readyz"
  - "High SLO burn rate on donation or project listing routes"
steps:
  - "Check Sentry dashboard for recent unhandled exceptions and stack traces."
  - "Inspect backend container logs using `kubectl logs -n stellar-indigopay -l app=backend --tail=100`."
  - "Verify upstream dependency status (Postgres database pool, Redis cache, Horizon node)."
  - "If error spike coincides with a recent deployment, initiate rollback via `kubectl rollout undo deployment/backend -n stellar-indigopay`."
verification:
  - "Confirm HTTP 5xx rate drops below 1% on Prometheus metrics."
  - "Verify /api/readyz returns 200 OK."
rollback:
  - "Revert backend deployment to the previous stable image tag."
---

# Backend HTTP 5xx Error Rate Runbook

## Overview
This runbook covers response procedures when the backend HTTP 5xx error rate exceeds threshold (5%) or readiness probes fail.

## Emergency Triage
1. **Log Inspection**:
   ```bash
   kubectl logs -n stellar-indigopay -l app=backend --tail=200 -f
   ```
2. **Readiness Probe**:
   ```bash
   kubectl exec -it -n stellar-indigopay deployment/backend -- curl -s http://localhost:4000/api/readyz
   ```
3. **Rollback (if post-deploy)**:
   ```bash
   kubectl rollout undo deployment/backend -n stellar-indigopay
   ```
