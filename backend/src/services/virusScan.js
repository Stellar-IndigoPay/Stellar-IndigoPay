"use strict";

const clamd = require("clamdjs");
const logger = require("../logger");
const { metrics } = require("./metrics");
const { AppError } = require("../errors");

const CLAMD_HOST = process.env.CLAMD_HOST || "127.0.0.1";
const CLAMD_PORT = parseInt(process.env.CLAMD_PORT || "3310", 10);
const CLAMD_FAIL_OPEN = String(process.env.CLAMD_FAIL_OPEN || "false").toLowerCase() === "true";

const scanner = clamd.createScanner(CLAMD_HOST, CLAMD_PORT);

/**
 * Scans a file buffer using ClamAV.
 * @param {Buffer} buffer 
 * @returns {Promise<{ clean: boolean, signature?: string }>}
 */
async function scanBuffer(buffer) {
  try {
    // 10 second timeout, 1MB chunk size
    const result = await scanner.scanBuffer(buffer, 10000, 1024 * 1024);
    
    if (result && result.includes("OK")) {
      metrics.virusScanTotal.inc({ result: "clean" });
      return { clean: true };
    }

    const match = result.match(/stream: (.+) FOUND/);
    const signature = match ? match[1] : "Unknown_Malware";

    metrics.virusScanTotal.inc({ result: "infected" });
    return { clean: false, signature };

  } catch (err) {
    logger.error({ event: "clamav_scan_error", err: err.message }, "Failed to scan file with ClamAV");
    
    if (CLAMD_FAIL_OPEN) {
      metrics.virusScanTotal.inc({ result: "skipped" });
      logger.warn({ event: "clamav_fail_open" }, "ClamAV unavailable, allowing upload because CLAMD_FAIL_OPEN=true");
      return { clean: true };
    }

    metrics.virusScanTotal.inc({ result: "error" });
    throw new AppError("SERVICE_UNAVAILABLE", {
      detail: "Security scanning service is currently unavailable.",
    });
  }
}

module.exports = {
  scanBuffer,
};
