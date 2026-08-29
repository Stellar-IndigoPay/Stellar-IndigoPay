"use strict";

/**
 * backend/test/properties/harness/projectionTestDb.js
 *
 * In-memory pg-client double that actually APPLIES the statements emitted by
 * the projection-engine handlers, so the real production handlers can be
 * driven against accumulated state and aggregate invariants asserted.
 *
 * Scope: it interprets ONLY the fixed statement shapes the four handlers in
 * src/services/projectionEngine.js emit (same approach as the recording fake
 * in src/services/__fakes__/poolFake.js, but with NUMERIC-exact arithmetic).
 * Numeric columns are stored as BigInt at the migration-defined scales
 *   - XLM amounts:  NUMERIC(20, 7) -> scale 7
 *   - CO2 kg:       NUMERIC(20, 4) -> scale 4
 * which is exactly PostgreSQL's decimal addition semantics for these
 * statements (no rounding: every generated input fits both precision and
 * scale).
 *
 * The oracle sums live in exactDecimal.js; this module never computes an
 * expected value — it only stores what the production handlers wrote.
 */

const { toScaled } = require("./exactDecimal");

const SCALE_XLM = 7;
const SCALE_CO2 = 4;

function result(rows = []) {
  return Promise.resolve({ rows, rowCount: rows.length });
}

/**
 * Create a fresh in-memory projection database + client.
 * Mirrors post-migration state: global_stats singleton row seeded at zero.
 */
function createProjectionDb() {
  // donor_address -> accumulated leaderboard row
  const leaderboard = new Map();
  // project_id -> accumulated project stats row
  const projectStats = new Map();
  // transaction_hash -> history row (unique index on transaction_hash)
  const history = new Map();
  const globalStats = {
    totalXlmRaised: 0n,
    totalCo2OffsetKg: 0n,
    totalDonations: 0,
    totalDonors: 0,
  };

  async function query(text, params = []) {
    if (text.includes("INSERT INTO projection_donor_leaderboard")) {
      const [donor, amountStr, projectsSupported, co2Str] = params;
      const amount = toScaled(String(amountStr), SCALE_XLM);
      const co2 = toScaled(String(co2Str), SCALE_CO2);
      const existing = leaderboard.get(donor);
      if (!existing) {
        leaderboard.set(donor, {
          totalDonated: amount,
          donationCount: 1,
          projectsSupported,
          totalCo2Offset: co2,
        });
      } else {
        existing.totalDonated += amount;
        existing.donationCount += 1;
        existing.projectsSupported = Math.max(
          existing.projectsSupported,
          projectsSupported,
        );
        existing.totalCo2Offset += co2;
      }
      return result();
    }

    if (text.includes("INSERT INTO projection_project_stats")) {
      const [projectId, amountStr, co2Str] = params;
      const amount = toScaled(String(amountStr), SCALE_XLM);
      const co2 = toScaled(String(co2Str), SCALE_CO2);
      const existing = projectStats.get(projectId);
      if (!existing) {
        projectStats.set(projectId, {
          raisedXlm: amount,
          donationCount: 1,
          donorCount: 0,
          co2OffsetKg: co2,
        });
      } else {
        existing.raisedXlm += amount;
        existing.donationCount += 1;
        existing.co2OffsetKg += co2;
      }
      return result();
    }

    if (text.includes("INSERT INTO projection_donor_history")) {
      const [donor, projectId, amountStr, , , txHash, co2Str] = params;
      if (history.has(txHash)) return result([]); // ON CONFLICT DO NOTHING
      history.set(txHash, {
        donorAddress: donor,
        projectId,
        amountXlm: toScaled(String(amountStr), SCALE_XLM),
        co2OffsetKg: toScaled(String(co2Str), SCALE_CO2),
      });
      return result();
    }

    if (text.includes("UPDATE projection_global_stats SET")) {
      const [amountStr, co2Str, donorDelta] = params;
      globalStats.totalXlmRaised += toScaled(String(amountStr), SCALE_XLM);
      globalStats.totalCo2OffsetKg += toScaled(String(co2Str), SCALE_CO2);
      globalStats.totalDonations += 1;
      globalStats.totalDonors += donorDelta;
      return result();
    }

    if (text.includes("UPDATE projection_project_stats SET donor_count")) {
      const [projectId, donorCount] = params;
      const row = projectStats.get(projectId);
      if (row) row.donorCount = donorCount;
      return result();
    }

    // SELECT COUNT(DISTINCT donor_address)::int AS c
    //   FROM projection_donor_history WHERE project_id = $1
    if (
      text.includes("COUNT(DISTINCT donor_address)") &&
      text.includes("WHERE project_id = $1")
    ) {
      const donors = new Set();
      for (const row of history.values()) {
        if (row.projectId === params[0]) donors.add(row.donorAddress);
      }
      return result([{ c: donors.size }]);
    }

    // SELECT 1 FROM projection_donor_history
    //   WHERE project_id = $1 AND donor_address = $2 LIMIT 1
    if (
      text.includes("FROM projection_donor_history") &&
      text.includes("project_id = $1") &&
      text.includes("donor_address = $2")
    ) {
      for (const row of history.values()) {
        if (row.projectId === params[0] && row.donorAddress === params[1]) {
          return result([{ "?column?": 1 }]);
        }
      }
      return result([]);
    }

    // SELECT 1 FROM projection_donor_history
    //   WHERE donor_address = $1 AND transaction_hash <> $2 LIMIT 1
    if (
      text.includes("FROM projection_donor_history") &&
      text.includes("donor_address = $1") &&
      text.includes("transaction_hash <> $2")
    ) {
      for (const [txHash, row] of history.entries()) {
        if (row.donorAddress === params[0] && txHash !== params[1]) {
          return result([{ "?column?": 1 }]);
        }
      }
      return result([]);
    }

    throw new Error(
      `projectionTestDb does not understand statement:\n${text}`,
    );
  }

  /**
   * Finalize donor_count from the fully-rebuilt history — mirrors the single
   * aggregate UPDATE that rebuildAllProjections runs after its replay.
   */
  function finalizeDonorCounts() {
    const perProject = new Map();
    for (const row of history.values()) {
      if (!perProject.has(row.projectId)) {
        perProject.set(row.projectId, new Set());
      }
      perProject.get(row.projectId).add(row.donorAddress);
    }
    for (const [projectId, donors] of perProject) {
      const statRow = projectStats.get(projectId);
      if (statRow) statRow.donorCount = donors.size;
    }
  }

  const client = {
    query(text, params) {
      return query(text, params);
    },
  };

  return {
    client,
    finalizeDonorCounts,
    globalStats,
    history,
    leaderboard,
    projectStats,
    query,
  };
}

/** Stable deep-equality-ready view of a db's state (sorted keys, BigInts). */
function snapshot(db) {
  const mapToObj = (m) =>
    Object.fromEntries(
      [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  return {
    globalStats: { ...db.globalStats },
    history: mapToObj(db.history),
    leaderboard: mapToObj(db.leaderboard),
    projectStats: mapToObj(db.projectStats),
  };
}

module.exports = { SCALE_CO2, SCALE_XLM, createProjectionDb, snapshot };
