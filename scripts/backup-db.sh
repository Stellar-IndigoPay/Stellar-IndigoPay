#!/bin/bash

# Database Backup Script
# Backs up PostgreSQL database and uploads to S3 or GCS
# Supports both AWS S3 and Google Cloud Storage

set -euo pipefail

# Configuration
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-stellar_indigopay}"
DB_PASSWORD="${DB_PASSWORD:-}"
BACKUP_DIR="${BACKUP_DIR:-/tmp/backups}"
STORAGE_TYPE="${STORAGE_TYPE:-s3}"  # 's3' or 'gcs'
S3_BUCKET="${S3_BUCKET:-}"
S3_PREFIX="${S3_PREFIX:-backups/}"
GCS_BUCKET="${GCS_BUCKET:-}"
GCS_PREFIX="${GCS_PREFIX:-backups/}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

# Timestamp for backup file
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="stellar_indigopay_backup_${TIMESTAMP}.sql.gz"
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_FILE}"

# Metadata / row-level checksum config (WS4 / #1100)
# These are the critical tables whose row-level checksums are computed during
# backup so a restore drill can detect silent corruption (not just empty tables).
CRITICAL_TABLES="${CRITICAL_TABLES:-donations donation_events projects profiles projection_donor_leaderboard projection_donor_history projection_project_stats projection_global_stats}"
VERIFY_AFTER_UPLOAD="${VERIFY_AFTER_UPLOAD:-true}"

# Logging
log_info() {
    echo "[INFO] $(date '+%Y-%m-%d %H:%M:%S') $1"
}

log_error() {
    echo "[ERROR] $(date '+%Y-%m-%d %H:%M:%S') $1" >&2
}

BACKUP_STARTED_AT=$(date +%s)

# Compute row-level checksums for the critical tables. Returns a JSON object
# of {table: checksum} written to BACKUP_CHECKSUM_FILE, empty on failure.
compute_row_checksums() {
    local db_host="$1" db_port="$2" db_user="$3" db_name="$4"
    local out_file="$5"
    : > "$out_file"
    if ! command -v psql &> /dev/null; then
        log_info "psql not available — skipping row-level checksums"
        return 0
    fi
    local first=1
    {
        printf '[ '
        for table in ${CRITICAL_TABLES}; do
            local checksum
            checksum=$(PGPASSWORD="$DB_PASSWORD" psql -h "$db_host" -p "$db_port" -U "$db_user" -d "$db_name" \
                -tAc "SELECT md5(string_agg(md5((t.*)::text), '' ORDER BY 1)) FROM (SELECT * FROM ${table} ORDER BY ctid) t;" 2>/dev/null || echo "unavailable")
            if [ "$first" = 1 ]; then first=0; else printf ', '; fi
            printf '{"table":"%s","md5":"%s"}' "$table" "$checksum"
        done
        # Record the expected server-side object counts (WS4 acceptance). A
        # restore drill compares the restored database against these so a schema
        # loss (indices/constraints/triggers/sequences) fails the drill even when
        # row counts look healthy. Kept inside the same array so existing jq
        # (`select(.table==$t)`) consumers are unaffected.
        local idx cnt trg seq_q
        idx=$(PGPASSWORD="$DB_PASSWORD" psql -h "$db_host" -p "$db_port" -U "$db_user" -d "$db_name" -tAc \
            "SELECT count(*) FROM pg_indexes WHERE schemaname='public';" 2>/dev/null | tr -d ' \n')
        cnt=$(PGPASSWORD="$DB_PASSWORD" psql -h "$db_host" -p "$db_port" -U "$db_user" -d "$db_name" -tAc \
            "SELECT count(*) FROM pg_constraint WHERE contype IN ('f','p','u');" 2>/dev/null | tr -d ' \n')
        trg=$(PGPASSWORD="$DB_PASSWORD" psql -h "$db_host" -p "$db_port" -U "$db_user" -d "$db_name" -tAc \
            "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal;" 2>/dev/null | tr -d ' \n')
        seq_q=$(PGPASSWORD="$DB_PASSWORD" psql -h "$db_host" -p "$db_port" -U "$db_user" -d "$db_name" -tAc \
            "SELECT count(*) FROM pg_class WHERE relkind='S' AND relnamespace=(SELECT oid FROM pg_namespace WHERE nspname='public');" 2>/dev/null | tr -d ' \n')
        idx="${idx:-0}"; cnt="${cnt:-0}"; trg="${trg:-0}"; seq_q="${seq_q:-0}"
        printf ', {"table":"__objects__","md5":"","indices":"%s","constraints":"%s","triggers":"%s","sequences":"%s"}' "$idx" "$cnt" "$trg" "$seq_q"
        printf ' ]'
    } > "$out_file"
    log_info "Computed row-level checksums + object-count expectations"
}

# Emit a Prometheus text-format metric line (WS4 observability).
# Includes backup_last_success_timestamp_seconds (unix epoch) so alerting can
# detect stalled backups by liveness/age instead of relying on the duration
# gauge not *changing* (identical durations across two backups would otherwise
# false-positive BackupStalled).
backup_metrics() {
    local size_bytes="$1" duration_seconds="$2"
    local last_success_ts
    last_success_ts=$(date +%s)
    echo "backup_backup_size_bytes ${size_bytes}"
    echo "backup_backup_duration_seconds ${duration_seconds}"
    echo "backup_last_success_timestamp_seconds ${last_success_ts}"
}

# Download the uploaded artifact and re-hash it, comparing against the local
# SHA-256. Fails the backup when they differ (silent corruption / partial
# write detection).
verify_after_upload() {
    if [ "$STORAGE_TYPE" = "s3" ]; then
        local remote="s3://${S3_BUCKET}/${S3_PREFIX}${BACKUP_FILE}"
        local dl="${BACKUP_DIR}/verify_download.sql.gz"
        if command -v aws >/dev/null 2>&1; then
            aws s3 cp "$remote" "$dl" --quiet || { log_error "verify_after_upload: download from S3 failed"; exit 1; }
            local actual
            actual=$(sha256sum "$dl" | awk '{print $1}')
            rm -f "$dl"
            if [ "$actual" != "$EXPECTED_HASH" ]; then
                log_error "VERIFICATION FAILED: uploaded artifact hash ${actual} != local hash ${EXPECTED_HASH}"
                exit 1
            fi
            log_info "Post-upload SHA-256 verification passed — local ${EXPECTED_HASH} == remote ${actual}"
        else
            log_info "aws CLI unavailable — skipping post-upload verification"
        fi
    elif [ "$STORAGE_TYPE" = "gcs" ]; then
        local dl="${BACKUP_DIR}/verify_download.sql.gz"
        if command -v gsutil >/dev/null 2>&1; then
            gsutil cp "gs://${GCS_BUCKET}/${GCS_PREFIX}${BACKUP_FILE}" "$dl" >/dev/null 2>&1 || { log_error "verify_after_upload: download from GCS failed"; exit 1; }
            local actual
            actual=$(sha256sum "$dl" | awk '{print $1}')
            rm -f "$dl"
            if [ "$actual" != "$EXPECTED_HASH" ]; then
                log_error "VERIFICATION FAILED: uploaded artifact hash ${actual} != local hash ${EXPECTED_HASH}"
                exit 1
            fi
            log_info "Post-upload SHA-256 verification passed — local ${EXPECTED_HASH} == remote ${actual}"
        else
            log_info "gsutil unavailable — skipping post-upload verification"
        fi
    else
        log_info "Unknown storage type — skipping post-upload verification"
    fi
}

# Create backup directory
mkdir -p "${BACKUP_DIR}"

log_info "Starting database backup..."
log_info "Database: $DB_NAME on $DB_HOST:$DB_PORT"
log_info "Backup file: $BACKUP_FILE"

# Export password if provided
if [ -n "$DB_PASSWORD" ]; then
    export PGPASSWORD="$DB_PASSWORD"
fi

# Create the backup
if ! pg_dump \
    -h "$DB_HOST" \
    -p "$DB_PORT" \
    -U "$DB_USER" \
    -d "$DB_NAME" \
    --no-password \
    | gzip > "$BACKUP_PATH"; then
    log_error "Database backup failed"
    exit 1
fi

log_info "Database backup completed successfully"
log_info "Backup file size: $(du -h "$BACKUP_PATH" | cut -f1)"

# ── Integrity: SHA-256 checksum of the backup artifact (#1100 / WS4) ──────
# Computed BEFORE upload so a restore drill can prove the uploaded byte-stream
# matches the bits we pushed. The .sha256 sidecar is uploaded next to the
# backup; verify-restore-checksum.sh re-hashes after download and compares.
BACKUP_HASH_FILE="${BACKUP_PATH}.sha256"
BACKUP_CHECKSUM_FILE="${BACKUP_PATH}.rowchecksums.json"
compute_row_checksums "$DB_HOST" "$DB_PORT" "$DB_USER" "$DB_NAME" "$BACKUP_CHECKSUM_FILE"
(
    cd "${BACKUP_DIR}" &&
    sha256sum "$(basename "$BACKUP_PATH")" > "$(basename "$BACKUP_HASH_FILE")"
)
EXPECTED_HASH=$(awk '{print $1}' "$BACKUP_HASH_FILE")
log_info "Backup SHA-256: ${EXPECTED_HASH}"
log_info "Row-level checksums: $BACKUP_CHECKSUM_FILE"

# Upload to cloud storage
case "$STORAGE_TYPE" in
    s3)
        upload_to_s3
        ;;
    gcs)
        upload_to_gcs
        ;;
    *)
        log_error "Unknown storage type: $STORAGE_TYPE"
        exit 1
        ;;
esac

# ── Post-upload verification: re-hash what we pushed and compare ──────────
if [ "$VERIFY_AFTER_UPLOAD" = "true" ]; then
    verify_after_upload
fi

BACKUP_ENDED_AT=$(date +%s)
BACKUP_DURATION=$((BACKUP_ENDED_AT - BACKUP_STARTED_AT))
BACKUP_SIZE_BYTES=$(stat -c%s "$BACKUP_PATH" 2>/dev/null || echo 0)
backup_metrics "$BACKUP_SIZE_BYTES" "$BACKUP_DURATION" > "${BACKUP_DIR}/backup_metrics.prom" || true

# Cleanup old backups locally
log_info "Cleaning up local backups older than $RETENTION_DAYS days..."
find "${BACKUP_DIR}" -name "stellar_indigopay_backup_*.sql.gz" -mtime "+${RETENTION_DAYS}" -delete
log_info "Local backup cleanup completed"

log_info "Database backup and upload completed successfully"

upload_to_s3() {
    if [ -z "$S3_BUCKET" ]; then
        log_error "S3_BUCKET environment variable is not set"
        return 1
    fi

    log_info "Uploading backup to S3..."
    
    # Validate AWS CLI is installed
    if ! command -v aws &> /dev/null; then
        log_error "AWS CLI is not installed"
        return 1
    fi

    # Upload to S3
    REMOTE_PATH="s3://${S3_BUCKET}/${S3_PREFIX}${BACKUP_FILE}"
    if aws s3 cp "$BACKUP_PATH" "$REMOTE_PATH" \
        --sse AES256 \
        --storage-class STANDARD_IA \
        --metadata "backup-date=${TIMESTAMP},database=${DB_NAME}"; then
        log_info "Successfully uploaded to $REMOTE_PATH"
    else
        log_error "Failed to upload backup to S3"
        return 1
    fi

    # Upload integrity sidecars so a restore drill can verify checksums.
    if [ -f "$BACKUP_HASH_FILE" ]; then
        aws s3 cp "$BACKUP_HASH_FILE" "s3://${S3_BUCKET}/${S3_PREFIX}${BACKUP_FILE}.sha256" --sse AES256 --quiet \
            || log_error "Failed to upload SHA-256 sidecar"
    fi
    if [ -f "$BACKUP_CHECKSUM_FILE" ]; then
        aws s3 cp "$BACKUP_CHECKSUM_FILE" "s3://${S3_BUCKET}/${S3_PREFIX}${BACKUP_FILE}.rowchecksums.json" --sse AES256 --quiet \
            || log_error "Failed to upload row-checksum sidecar"
    fi
    return 0
}

upload_to_gcs() {
    if [ -z "$GCS_BUCKET" ]; then
        log_error "GCS_BUCKET environment variable is not set"
        return 1
    fi

    log_info "Uploading backup to GCS..."

    # Validate gsutil is installed
    if ! command -v gsutil &> /dev/null; then
        log_error "gsutil (Google Cloud SDK) is not installed"
        return 1
    fi

    # Upload to GCS
    REMOTE_PATH="gs://${GCS_BUCKET}/${GCS_PREFIX}${BACKUP_FILE}"
    if gsutil -h "Content-Type:application/gzip" \
        -h "x-goog-meta-backup-date:${TIMESTAMP}" \
        -h "x-goog-meta-database:${DB_NAME}" \
        cp "$BACKUP_PATH" "$REMOTE_PATH"; then
        log_info "Successfully uploaded to $REMOTE_PATH"
    else
        log_error "Failed to upload backup to GCS"
        return 1
    fi

    # Upload integrity sidecars so a restore drill can verify checksums.
    if [ -f "$BACKUP_HASH_FILE" ]; then
        gsutil cp "$BACKUP_HASH_FILE" "gs://${GCS_BUCKET}/${GCS_PREFIX}${BACKUP_FILE}.sha256" >/dev/null 2>&1 \
            || log_error "Failed to upload SHA-256 sidecar"
    fi
    if [ -f "$BACKUP_CHECKSUM_FILE" ]; then
        gsutil cp "$BACKUP_CHECKSUM_FILE" "gs://${GCS_BUCKET}/${GCS_PREFIX}${BACKUP_FILE}.rowchecksums.json" >/dev/null 2>&1 \
            || log_error "Failed to upload row-checksum sidecar"
    fi
    return 0
}
