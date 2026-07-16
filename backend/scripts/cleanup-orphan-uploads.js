"use strict";

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const pool = require("../src/db/pool");
const logger = require("../src/logger");
const { UPLOAD_DIR } = require("../src/services/storage");
const { logAdminAction } = require("../src/services/audit");

async function cleanupOrphans() {
  logger.info({ event: "orphan_cleanup_start" }, "Starting orphan uploads cleanup");

  try {
    // Find uploads older than 7 days that don't belong to a project
    const orphansRes = await pool.query(`
      SELECT id, storage_key, original_name, size_bytes
      FROM project_uploads
      WHERE project_id IS NULL
        AND created_at < NOW() - INTERVAL '7 days'
    `);

    const orphans = orphansRes.rows;
    if (orphans.length === 0) {
      logger.info({ event: "orphan_cleanup_done", count: 0 }, "No orphan uploads to clean up");
      process.exit(0);
    }

    // Load all verification request documents
    const vrRes = await pool.query("SELECT supporting_documents FROM verification_requests");
    const activeKeys = new Set();
    
    for (const row of vrRes.rows) {
      const docs = row.supporting_documents || [];
      for (const doc of docs) {
        if (doc.url) {
          try {
            const parsed = new URL(doc.url, "http://localhost");
            if (parsed.pathname.startsWith("/api/uploads/")) {
              const key = decodeURIComponent(path.posix.basename(parsed.pathname));
              if (key) activeKeys.add(key);
            }
          } catch (e) {
            // ignore malformed URLs
          }
        }
      }
    }

    let deletedCount = 0;
    let failedCount = 0;

    for (const orphan of orphans) {
      if (activeKeys.has(orphan.storage_key)) {
        // Linked to a verification request, skip
        continue;
      }

      // Delete from local storage (if it exists)
      const fullPath = path.join(UPLOAD_DIR, orphan.storage_key);
      try {
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
      } catch (err) {
        logger.error({ event: "orphan_cleanup_fs_error", err: err.message, key: orphan.storage_key }, "Failed to delete file from disk");
        failedCount++;
        continue;
      }

      // Delete from database
      await pool.query("DELETE FROM project_uploads WHERE id = $1", [orphan.id]);

      // Audit Log
      logAdminAction({
        actor: "system",
        action: "delete_orphan_upload",
        targetType: "file",
        targetId: orphan.storage_key,
        metadata: {
          fileName: orphan.original_name,
          fileSize: orphan.size_bytes,
        }
      });

      logger.info({ event: "orphan_deleted", key: orphan.storage_key }, "Deleted orphan upload");
      deletedCount++;
    }

    logger.info({ event: "orphan_cleanup_done", deletedCount, failedCount }, "Orphan uploads cleanup complete");
    process.exit(0);

  } catch (err) {
    logger.error({ event: "orphan_cleanup_error", err: err.message }, "Orphan cleanup failed");
    process.exit(1);
  }
}

if (require.main === module) {
  cleanupOrphans();
}

module.exports = cleanupOrphans;
