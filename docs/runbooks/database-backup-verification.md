---
title: Database Backup Failure and Verification Incident Response
severity: page
owners:
  - "@oncall-team"
symptoms:
  - "BackupVerificationFailed or BackupMissed or RestoreDrillFailed alert firing"
  - "No valid database backup artifact found in target S3 bucket"
steps:
  - "Check GitHub Actions workflow logs for `.github/workflows/database-backup.yml` or `restore-drill.yml`."
  - "Manually run database backup script `scripts/backup-db.sh`."
  - "Execute verification test `node backend/__tests__/scripts/verify-backup.test.js`."
  - "Inspect storage capacity and permissions on backup destination."
verification:
  - "Verify new backup artifact exists, passes checksum, and restores cleanly."
rollback:
  - "Fix storage permissions or restore from previous day's verified WAL backup."
---

# Database Backup Verification Runbook

## Overview
Triggered when automated backup creation, checksum validation, or monthly restore drills fail.
