/**
 * src/routes/map.js
 * GET /api/map — geo-located project data for the world map.
 *
 * Returns all active projects with coordinates for rendering on the
 * interactive world map. Cached for 10 minutes via Redis.
 */
"use strict";

const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { cacheResponse } = require("../middleware/cache");

const VALID_CATEGORIES = [
  "Reforestation",
  "Solar Energy",
  "Ocean Conservation",
  "Clean Water",
  "Wildlife Protection",
  "Carbon Capture",
  "Wind Energy",
  "Sustainable Agriculture",
  "Other",
];

router.get("/", cacheResponse(600, (req) => {
  const params = { ...req.query };
  Object.keys(params).forEach((k) => {
    if (params[k] === undefined || params[k] === null || params[k] === "") {
      delete params[k];
    }
  });
  return `cache:v1:map:${require("crypto").createHash("md5").update(JSON.stringify(params)).digest("hex")}`;
}), async (req, res, next) => {
  try {
    const { category, status } = req.query;
    const where = ["latitude IS NOT NULL AND longitude IS NOT NULL"];
    const values = [];

    if (status && ["active", "completed", "paused"].includes(status)) {
      values.push(status);
      where.push(`status = $${values.length}`);
    } else {
      where.push("status = 'active'");
    }

    if (category && VALID_CATEGORIES.includes(category)) {
      values.push(category);
      where.push(`category = $${values.length}`);
    }

    /* eslint-disable-next-line sql-injection/no-sql-injection */
    const result = await pool.query(
      `SELECT id, name, category, location, latitude, longitude,
              raised_xlm, co2_offset_kg, status, verified
       FROM projects
       WHERE ${where.join(" AND ")}
       ORDER BY raised_xlm DESC`,
      values,
    );

    res.json({
      success: true,
      data: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        category: row.category,
        location: row.location,
        latitude: Number.parseFloat(row.latitude),
        longitude: Number.parseFloat(row.longitude),
        raisedXLM: row.raised_xlm?.toString() || "0",
        co2OffsetKg: Number.parseInt(row.co2_offset_kg, 10) || 0,
        status: row.status,
        verified: Boolean(row.verified),
      })),
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
