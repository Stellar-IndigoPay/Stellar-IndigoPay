# Database Documentation

## Overview

Stellar-IndigoPay uses PostgreSQL 16 as its primary database for managing user accounts, transactions, and smart contract interactions.## Database Setup

### Docker Compose (Development)

The database is configured in `docker-compose.yml` with a primary and warm standby:

```yaml
# Primary (read/write)
postgres:
  image: postgres:16-alpine
  ports:
    - "5432:5432"
  # ... with replication enabled

# Warm standby (read-only, streaming replication)
postgres-standby:
  image: postgres:16-alpine
  ports:
    - "5433:5432"
  # ... hot_standby=on, streams from primary
```

**Default credentials** (development only):

- Username: `postgres`
- Password: `postgres`
- Database: `stellar_indigopay`
- Port: `5432` (primary), `5433` (standby)
- Replication user: `replicator` / `replicator`

### Production Database

For production deployments:

- Use streaming replication with a warm standby in a different region/zone
- Enable WAL archiving to S3 for point-in-time recovery
- Use strong, randomly generated passwords for all users
- Enable SSL/TLS connections
- Configure proper firewall rules and NetworkPolicies
- Use `external-secrets-operator` to hydrate credentials from AWS Secrets Manager
- Enable automated nightly backups

See `docs/disaster-recovery.md` for the full DR architecture.

## Database Backup Strategy

### Automated Backups

Stellar-IndigoPay implements automated nightly database backups to cloud storage for disaster recovery.

#### Backup Flow

```
PostgreSQL Database → pg_dump → gzip compression → Cloud Storage (S3/GCS)
```

#### Configuration

Backups are configured via GitHub Actions workflow: `.github/workflows/database-backup.yml`

**Schedule:** Daily at 2 AM UTC (configurable)

**Storage Options:**

- **AWS S3:** Default option for AWS deployments
- **Google Cloud Storage:** Option for GCP deployments

#### Required Environment Variables

For GitHub Actions secrets, configure the following:

**Common:**

- `DB_HOST`: Database hostname/IP
- `DB_PORT`: Database port (default: 5432)
- `DB_USER`: Database user
- `DB_PASSWORD`: Database password
- `DB_NAME`: Database name (default: indigopay)
- `BACKUP_RETENTION_DAYS`: Days to retain backups (default: 30)

**For S3 Backups:**

- `AWS_ACCESS_KEY_ID`: AWS access key
- `AWS_SECRET_ACCESS_KEY`: AWS secret key
- `AWS_REGION`: AWS region (default: us-east-1)
- `S3_BUCKET`: S3 bucket name
- `S3_PREFIX`: S3 prefix for backups (default: `backups/`)

**For GCS Backups:**

- `GCS_SA_KEY`: Google Cloud Service Account JSON key (base64 encoded)
- `GCP_PROJECT_ID`: GCP project ID
- `GCS_BUCKET`: GCS bucket name
- `GCS_PREFIX`: GCS prefix for backups (default: `backups/`)

### Backup File Format

- **Naming:** `indigopay_backup_YYYYMMDD_HHMMSS.sql.gz`
- **Format:** SQL dump compressed with gzip
- **Size:** ~10-100 MB typical (depends on data volume)
- **Metadata:** Backup timestamp and database name stored in cloud storage metadata

### Manual Backups

To manually create a backup:

```bash
# Using the backup script
export DB_HOST=localhost
export DB_PORT=5432
export DB_USER=postgres
export DB_PASSWORD=postgres
export DB_NAME=indigopay
export STORAGE_TYPE=s3  # or 'gcs'
export S3_BUCKET=my-backup-bucket
export BACKUP_DIR=/tmp/backups

bash scripts/backup-db.sh
```

**Local backup only (without cloud upload):**

```bash
pg_dump -h localhost -p 5432 -U postgres indigopay | gzip > indigopay_backup_$(date +%Y%m%d_%H%M%S).sql.gz
```

## Streaming Replication & Warm Standby

### Overview

Stellar-IndigoPay uses PostgreSQL native streaming replication with a warm
standby for multi-region disaster recovery. The standby continuously receives
WAL from the primary via a replication slot, staying in sync within seconds.

### Architecture

```
Primary (us-east-1)                  Standby (us-west-2)
┌─────────────────┐                  ┌─────────────────┐
│ postgres-primary │  streaming WAL   │ postgres-standby │
│ wal_level=replica│ ═══════════════► │ hot_standby=on   │
│ max_wal_senders=5│                  │ read-only        │
└────────┬────────┘                  └─────────────────┘
         │ WAL archive (every 5 min)
         ▼
   ┌──────────┐
   │ S3 bucket │◄── fallback restore
   └──────────┘
```

### Initial Setup

Run the setup script after deploying both StatefulSets:

```bash
bash scripts/setup-replication.sh
```

### Verify Replication

```bash
# Check replication status on primary
kubectl exec -n stellar-indigopay postgres-primary-0 -- \
  psql -U postgres -c "SELECT application_name, state, sync_state,
    pg_wal_lsn_diff(pg_current_wal_lsn(), sent_lsn) AS lag_bytes
    FROM pg_stat_replication;"

# Check recovery status on standby
kubectl exec -n stellar-indigopay postgres-standby-0 -- \
  psql -U postgres -c "SELECT pg_is_in_recovery();"
# Should return 't' (true) — standby is in recovery mode
```

### Manual Failover

See the failover procedure in `docs/disaster-recovery.md`. In a real incident:

1. Promote standby: `pg_ctl promote` (or `touch /tmp/trigger_promote`)
2. Update `DATABASE_URL` to point at the promoted standby
3. Restart backend pods

### Local Development

```bash
# Start primary + standby for local DR testing
docker compose up -d postgres postgres-standby

# Verify replication
docker compose exec postgres psql -U postgres -c \
  "SELECT client_addr, state FROM pg_stat_replication;"

# The standby is at localhost:5433 (read-only)
docker compose exec postgres-standby psql -U postgres -c \
  "SELECT 1;"  # read queries work, writes fail
```

### Prerequisites

Before restoring, ensure:

1. PostgreSQL client tools are installed
2. Target PostgreSQL server is running and accessible
3. You have credentials with database creation privileges
4. Backup file is available (local or downloaded from cloud storage)

### Restore from S3 Backup

```bash
# 1. List available backups in S3
aws s3 ls s3://my-backup-bucket/backups/

# 2. Download the backup file
aws s3 cp s3://my-backup-bucket/backups/indigopay_backup_20240101_020000.sql.gz .

# 3. Decompress
gunzip indigopay_backup_20240101_020000.sql.gz

# 4. Restore to database (see "Restore to PostgreSQL" section below)
```

### Restore from GCS Backup

```bash
# 1. List available backups in GCS
gsutil ls gs://my-backup-bucket/backups/

# 2. Download the backup file
gsutil cp gs://my-backup-bucket/backups/indigopay_backup_20240101_020000.sql.gz .

# 3. Decompress
gunzip indigopay_backup_20240101_020000.sql.gz

# 4. Restore to database (see "Restore to PostgreSQL" section below)
```

### Restore to PostgreSQL

#### Option 1: Restore to Existing Database (Replace)

```bash
# Decompress if needed
gunzip indigopay_backup_*.sql.gz

# Drop existing database (WARNING: Data will be lost)
dropdb -h localhost -U postgres indigopay

# Create fresh database
createdb -h localhost -U postgres indigopay

# Restore from backup
psql -h localhost -U postgres indigopay < indigopay_backup_*.sql
```

#### Option 2: Restore to New Database (Parallel)

```bash
# Decompress if needed
gunzip indigopay_backup_*.sql.gz

# Create new database with different name
createdb -h localhost -U postgres indigopay_restored

# Restore from backup
psql -h localhost -U postgres indigopay_restored < indigopay_backup_*.sql

# Verify data integrity
psql -h localhost -U postgres indigopay_restored -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';"
```

#### Option 3: Restore with Docker Compose

```bash
# 1. Copy backup file to container
docker cp indigopay_backup_*.sql indigopay-postgres-1:/tmp/

# 2. Decompress inside container
docker exec indigopay-postgres-1 gunzip /tmp/indigopay_backup_*.sql.gz

# 3. Drop and recreate database
docker exec -e PGPASSWORD=postgres indigopay-postgres-1 dropdb -U postgres indigopay
docker exec -e PGPASSWORD=postgres indigopay-postgres-1 createdb -U postgres indigopay

# 4. Restore
docker exec -e PGPASSWORD=postgres indigopay-postgres-1 psql -U postgres indigopay < indigopay_backup_*.sql
```

### Restore with Docker Compose (Alternative)

```bash
# Using docker-compose with mounted volume
docker-compose exec -T postgres sh -c 'gunzip /tmp/backup.sql.gz && psql -U postgres indigopay < /tmp/backup.sql'
```

### Verify Restore Success

After restoring, verify the backup:

```bash
# Connect to restored database
psql -h localhost -U postgres indigopay

# Check table counts
SELECT schemaname, COUNT(*) as table_count
FROM pg_tables
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
GROUP BY schemaname;

# Check for data
SELECT COUNT(*) FROM users;
SELECT COUNT(*) FROM transactions;

# Exit
\q
```

## Point-in-Time Recovery (PITR)

For point-in-time recovery:

1. Enable WAL (Write-Ahead Logging) archiving
2. Archive WAL files to S3/GCS
3. Use `pg_restore` with recovery target time

Example configuration in postgresql.conf:

```postgresql
wal_level = replica
archive_mode = on
archive_command = 'aws s3 cp %p s3://my-backup-bucket/wal/%f'
archive_timeout = 300
```

## Backup Testing

### Automated Testing

The backup workflow includes failure notifications. Failed backups will create an issue in the repository.

### Manual Restore Test

To verify backup integrity:

```bash
# 1. Create a temporary PostgreSQL instance
docker run -d \
  --name postgres-test \
  -e POSTGRES_PASSWORD=testpass \
  -p 5433:5432 \
  postgres:16-alpine

# 2. Download and restore backup
aws s3 cp s3://my-backup-bucket/backups/indigopay_backup_latest.sql.gz .
gunzip indigopay_backup_latest.sql.gz

# 3. Wait for container to be ready
sleep 10

# 4. Create database and restore
PGPASSWORD=testpass psql -h localhost -p 5433 -U postgres -c "CREATE DATABASE indigopay;"
PGPASSWORD=testpass psql -h localhost -p 5433 -U postgres indigopay < indigopay_backup_latest.sql

# 5. Verify data
PGPASSWORD=testpass psql -h localhost -p 5433 -U postgres indigopay -c "SELECT COUNT(*) FROM information_schema.tables;"

# 6. Cleanup
docker stop postgres-test
docker rm postgres-test
```

## Troubleshooting

### Backup Fails with "could not connect to server"

**Solution:**

- Verify database credentials in GitHub Actions secrets
- Check database hostname/IP accessibility from GitHub Actions runners
- Ensure database user has backup permissions
- For private databases, consider using GitHub Actions self-hosted runners

### Restore Fails with "permission denied"

**Solution:**

```bash
# Restore with appropriate role/owner
pg_restore -h localhost -U postgres --role=postgres indigopay_backup.sql
```

### Backup File Corrupted

**Solution:**

1. Verify file integrity: `file indigopay_backup_*.sql.gz`
2. Try to decompress: `gunzip -t indigopay_backup_*.sql.gz`
3. Try alternate backup from S3/GCS
4. If all backups corrupted, contact DevOps team

### Out of Disk Space During Restore

**Solution:**

```bash
# Use streaming restore instead
psql -h localhost -U postgres indigopay < backup.sql | head -n 1000

# Or restore in chunks if backup is very large
```

## Performance Tuning

### Backup Performance

For faster backups, use parallel dump:

```bash
pg_dump -h localhost -U postgres indigopay \
  --jobs=4 \
  --format=directory \
  --verbose > indigopay_backup_parallel
```

### Restore Performance

For faster restores:

```bash
# Disable indexes during restore
psql -h localhost -U postgres indigopay \
  -v ON_ERROR_STOP=1 \
  --single-transaction < backup.sql
```

## Security Considerations

1. **Encryption in Transit:** Use SSL/TLS for database connections
2. **Encryption at Rest:** Enable S3/GCS encryption
3. **Access Control:** Use IAM roles and service accounts with least privilege
4. **Audit Logging:** Enable CloudTrail (AWS) or Cloud Audit Logs (GCP)
5. **Retention Policy:** Set appropriate backup retention based on compliance requirements
6. **Sensitive Data:** Consider PII redaction in backups for non-production environments

## Data Retention Policies

IndigoPay implements automated, config-driven data-retention policies so that
non-essential and personal data is purged or anonymized on a schedule while
on-chain auditability and donation records are preserved.

### Configuration

Policies are declared centrally in `backend/src/config/retentionPolicies.js`.
The worker (`backend/src/services/retentionWorker.js`) reads them and never
hard-codes policy logic. Each policy defines:

- `name` — unique policy identifier
- `table` — target table (restricted to an allow-list)
- `strategy` — `delete` or `anonymize`
- `retentionPeriod` — `{ value, unit }` (days | months | years)
- `schedule` — `{ cron, timezone }` for the pg-boss recurring job
- `condition` — parameterized WHERE clause (retention value bound as `$1`)
- `anonymizeFields` / `anonymizedAtColumn` — for the `anonymize` strategy
- `description` — human-readable summary

### Delete vs. Anonymize

- **delete** — physically removes rows that are older than the retention period
  and match the condition. Used for data with no long-term compliance value:
  stale device push tokens, terminal webhook delivery receipts, dead-letter
  webhook entries, and pg-boss job archives.
- **anonymize** — nulls personally identifiable columns (e.g. `email`,
  `donor_address`) and stamps `anonymised_at`, preserving the row so aggregate
  counts survive. Idempotent: already-anonymized rows are excluded by the
  WHERE clause. Currently applied to `project_subscriptions`.

### Default policies

| Policy | Table | Strategy | Retention | Notes |
| --- | --- | --- | --- | --- | --- |
| `project-subscriptions-anonymize` | `project_subscriptions` | anonymize | 24 months | Nulls `email`/`donor_address`, sets `anonymised_at` |
| `device-tokens-delete` | `device_tokens` | delete | 12 months | Removes un-refreshed push tokens |
| `webhook-deliveries-delete` | `webhook_deliveries` | delete | 90 days | Only `delivered`/`dlq` rows (in-flight retries preserved) |
| `webhook-dlq-delete` | `webhook_dlq` | delete | 180 days | Dead-letter sink purge |
| `pgboss-archive-delete` | `pgboss.archive` | delete | 30 days | Operational job history only |

### Preserved data (never retained)

- **Donations** — immutable on-chain ledger (`donations`); retained indefinitely.
- **On-chain references** — `transaction_hash`, `release_transaction_hash`, and
  any Soroban/Stellar identifiers are never modified or deleted.
- **Audit logs** — `admin_audit_log` is excluded from default delete policies.
  Audit-log pruning (where required for compliance) is a separate, flag-gated
  concern in `backend/src/services/auditRetention.js` (`AUDIT_LOG_RETENTION_ENABLED`).

### Migration support

Migration `018_retention_columns` adds:

- `project_subscriptions.anonymised_at` — anonymization marker (indexed).
- `device_tokens.retention_expires_at`, `webhook_deliveries.retention_expires_at`,
  `webhook_dlq.retention_expires_at` — explicit, index-friendly expiry markers.

All columns are nullable and added with `IF NOT EXISTS`, so the migration is
idempotent and backward compatible.

### Compliance notes

- Table and column identifiers in policies are validated at load time against a
  strict allow-list, so retention can never target an unexpected table (e.g.
  `donations`) and dynamic queries are SQL-injection-safe (values are always
  bound parameters).
- Every policy execution writes an `admin_audit_log` entry (`action:
  retention.run`) recording the policy, strategy, affected row count, and status.
- Metrics: `retention_rows_cleaned_total{policy,strategy}`,
  `retention_last_run_timestamp_seconds{policy}`,
  `retention_run_errors_total{policy}` (exposed on `/metrics`).
- Admin endpoints: `GET /api/admin/retention/status` and
  `POST /api/admin/retention/run-now` (validates policy names, returns
  structured errors, and a `207 Multi-Status` when some policies fail).

## Related Files

- Backup Script: [scripts/backup-db.sh](../scripts/backup-db.sh)
- Replication Setup: [scripts/setup-replication.sh](../scripts/setup-replication.sh)
- GitHub Actions Workflow: [.github/workflows/database-backup.yml](../.github/workflows/database-backup.yml)
- Disaster Recovery Plan: [docs/disaster-recovery.md](../docs/disaster-recovery.md)
- Restore Runbook: [docs/restore-runbook.md](../docs/restore-runbook.md)
- Primary K8s Manifest: [k8s/postgres.yaml](../k8s/postgres.yaml)
- Standby K8s Manifest: [k8s/postgres-standby.yaml](../k8s/postgres-standby.yaml)
- Docker Compose: [docker-compose.yml](../docker-compose.yml)

## Contact & Support

For database issues or backup concerns:

- Create an issue: [GitHub Issues](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues)
- Check existing documentation: [README.md](../README.md)
