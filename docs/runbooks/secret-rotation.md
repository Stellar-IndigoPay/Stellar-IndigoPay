---
title: Automated Secret Rotation Failure or Overdue Incident Response
severity: page
owners:
  - "@oncall-team"
symptoms:
  - "SecretRotationFailed or SecretRotationStuck or SecretRotationOverdue alert active"
  - "Automated rotation workflow failed or exceeded 95 days"
steps:
  - "Check GitHub Actions run for `.github/workflows/secret-rotation.yml`."
  - "Inspect audit log in `scripts/workflow/record_rotation.py` for failure details."
  - "If rotation was rolled back, verify application services are operating with existing keys."
  - "Re-run secret rotation workflow manually after correcting underlying secrets manager permissions."
verification:
  - "Confirm `secret_rotation_last_timestamp` metric updates to current timestamp with status success."
rollback:
  - "Trigger secret rollback step via workflow dispatch if partial rotation broke application auth."
---

# Secret Rotation Runbook

## Overview
Triggered when automated quarterly secret rotation fails or gets stuck.
