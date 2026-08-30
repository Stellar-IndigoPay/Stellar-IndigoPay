"use strict";

const PgBoss = require("pg-boss");
const logger = require("../../logger");
const { processExportJob } = require("./exportWorker");

const EXPORT_QUEUE = "dsr-export";
const PURGE_QUEUE = "dsr-purge";
const ERASE_QUEUE = "dsr-erase";
let boss = null;

async function start() {
  if (boss) return;
  const connectionString =
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/indigopay";
  boss = new PgBoss(connectionString);
  
  boss.on("error", (err) =>
    logger.error(
      { event: "dsr_queue_error", err: err.message },
      "pg-boss error in dsrQueue"
    )
  );

  await boss.start();
  await boss.createQueue(EXPORT_QUEUE);
  await boss.createQueue(PURGE_QUEUE);
  await boss.createQueue(ERASE_QUEUE);

  const { processEraseJob } = require("./eraseWorker");

  await boss.work(ERASE_QUEUE, { teamSize: 2, teamConcurrency: 1 }, async ([job]) => {
    try {
      return await processEraseJob(job);
    } catch (err) {
      logger.error({ event: "dsr_erase_failed", err: err.message }, "DSR Erase failed");
      throw err;
    }
  });

  await boss.work(EXPORT_QUEUE, { teamSize: 2, teamConcurrency: 1 }, async ([job]) => {
    try {
      const output = await processExportJob(job);
      
      // Enqueue the purge job using the returned key and expiresAt
      if (output.key && output.expiresAt) {
        const delaySeconds = Math.max(0, Math.floor((new Date(output.expiresAt).getTime() - Date.now()) / 1000));
        await boss.send(PURGE_QUEUE, { key: output.key, backend: output.backend }, { startAfter: delaySeconds });
      }
      
      return output;
    } catch (err) {
      logger.error({ event: "dsr_export_failed", err: err.message }, "DSR Export failed");
      throw err;
    }
  });

  await boss.work(PURGE_QUEUE, { teamSize: 1, teamConcurrency: 1 }, async ([job]) => {
    // Purge mechanism implementation
    const { key, backend } = job.data;
    if (backend === "local") {
      const fs = require("fs");
      const path = require("path");
      const { UPLOAD_DIR } = require("../storage");
      const fullPath = path.join(UPLOAD_DIR, key);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    } else {
      logger.info({ event: "dsr_purge_skipped", backend }, "Purge not implemented for this backend yet.");
    }
  });
}

async function enqueueExportJob(donorAddress) {
  if (!boss) throw new Error("pg-boss not started");
  const jobId = await boss.send(EXPORT_QUEUE, { donorAddress }, { retryLimit: 2 });
  return jobId;
}

async function getJobStatus(jobId) {
  if (!boss) throw new Error("pg-boss not started");
  const job = await boss.getJobById(jobId);
  return job;
}

async function enqueueEraseJob(donorAddress) {
  if (!boss) throw new Error("pg-boss not started");
  const jobId = await boss.send(ERASE_QUEUE, { donorAddress }, { retryLimit: 2 });
  return jobId;
}

module.exports = {
  start,
  enqueueExportJob,
  enqueueEraseJob,
  getJobStatus
};
