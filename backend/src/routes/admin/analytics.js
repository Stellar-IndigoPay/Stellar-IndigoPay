"use strict";

/**
 * routes/admin/analytics.js
 *
 * Admin analytics API endpoints.
 *
 * GET  /api/v1/admin/analytics/trends?from=YYYY-MM-DD&to=YYYY-MM-DD
 * GET  /api/v1/admin/analytics/projects
 * GET  /api/v1/admin/analytics/geographic
 * GET  /api/v1/admin/analytics/retention
 * GET  /api/v1/admin/analytics/categories?from=YYYY-MM-DD&to=YYYY-MM-DD
 * GET  /api/v1/admin/analytics/growth
 * GET  /api/v1/admin/analytics/export?type=csv|json&view=trends|projects|growth
 */

const express = require("express");
const router = express.Router();
const { adminRequired } = require("../../middleware/auth");
const {
  getDonationTrends,
  getProjectPerformance,
  getGeographicImpact,
  getDonorRetention,
  getCategoryBreakdown,
  getPlatformGrowth,
} = require("../../services/analyticsService");
const { AppError, sendAppError } = require("../../errors");

router.use(adminRequired);

/**
 * Parse and validate an optional ?from=YYYY-MM-DD&to=YYYY-MM-DD range.
 * Bounds stay optional; invalid dates are rejected up front (400) instead of
 * being handed to Postgres as garbage, and Date objects let the service clamp
 * the window to a bounded number of days.
 */
function parseDateRange(req) {
  const range = {
    from: req.query.from || null,
    to: req.query.to || null,
  };
  for (const [field, value] of Object.entries(range)) {
    if (!value) continue;
    if (Number.isNaN(Date.parse(value))) {
      throw new AppError("VALIDATION_ERROR", {
        field,
        detail: `Invalid ${field} date: ${value}`,
      });
    }
  }
  return range;
}

// ── GET /trends ────────────────────────────────────────────────────
router.get("/trends", async (req, res, next) => {
  try {
    const range = parseDateRange(req);
    const data = await getDonationTrends(range);
    res.json({ success: true, data });
  } catch (e) {
    next(e);
  }
});

// ── GET /projects ──────────────────────────────────────────────────
router.get("/projects", async (req, res, next) => {
  try {
    const data = await getProjectPerformance();
    res.json({ success: true, data });
  } catch (e) {
    next(e);
  }
});

// ── GET /geographic ────────────────────────────────────────────────
router.get("/geographic", async (req, res, next) => {
  try {
    const data = await getGeographicImpact();
    res.json({ success: true, data });
  } catch (e) {
    next(e);
  }
});

// ── GET /retention ─────────────────────────────────────────────────
router.get("/retention", async (req, res, next) => {
  try {
    const data = await getDonorRetention();
    res.json({ success: true, data });
  } catch (e) {
    next(e);
  }
});

// ── GET /categories ────────────────────────────────────────────────
router.get("/categories", async (req, res, next) => {
  try {
    const range = parseDateRange(req);
    const data = await getCategoryBreakdown(range);
    res.json({ success: true, data });
  } catch (e) {
    next(e);
  }
});

// ── GET /growth ────────────────────────────────────────────────────
router.get("/growth", async (req, res, next) => {
  try {
    const data = await getPlatformGrowth();
    res.json({ success: true, data });
  } catch (e) {
    next(e);
  }
});

// ── GET /export ────────────────────────────────────────────────────
router.get("/export", async (req, res, next) => {
  try {
    const view = String(req.query.view || "trends");
    const format = String(req.query.type || "json");
    const range = parseDateRange(req);

    let data;
    let filename;

    switch (view) {
    case "trends":
      data = await getDonationTrends(range);
      filename = "donation-trends";
      break;
    case "projects":
      data = await getProjectPerformance();
      filename = "project-performance";
      break;
    case "growth":
      data = await getPlatformGrowth();
      filename = "platform-growth";
      break;
    case "retention":
      data = await getDonorRetention();
      filename = "donor-retention";
      break;
    case "categories":
      data = await getCategoryBreakdown(range);
      filename = "category-breakdown";
      break;
    default:
      return sendAppError(res, "VALIDATION_ERROR", {
        field: "view",
        detail: `Unknown view: ${view}`,
      });
    }

    if (format === "csv") {
      const rows = Array.isArray(data) ? data : [data];
      if (rows.length === 0) {
        return res.status(200).set({
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="${filename}.csv"`,
        }).send("");
      }

      const headers = Object.keys(rows[0]);
      const csv = [
        headers.join(","),
        ...rows.map((row) =>
          headers.map((h) => {
            const val = row[h];
            if (val === null || val === undefined) return "";
            const str = String(val);
            return str.includes(",") || str.includes("\"") || str.includes("\n")
              ? `"${str.replace(/"/g, "\"\"")}"`
              : str;
          }).join(","),
        ),
      ].join("\n");

      res.set({
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="${filename}.csv"`,
      });
      return res.send(csv);
    }

    // JSON export
    res.set({
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${filename}.json"`,
    });
    return res.json({ success: true, view, data });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
