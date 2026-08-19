"use strict";

/**
 * In-memory fake of the `bulk_ops` table + transaction plumbing, matching
 * the exact queries issued by src/services/bulkOps.js. Used by
 * bulkOps.test.js and routes/admin/bulkOps.test.js so both can exercise the
 * real service/route code without a live Postgres instance.
 *
 * `extraHandlers` lets callers (e.g. the route test, which also needs a
 * fake `projects` table for the registered op type) plug in handlers for
 * queries this fake doesn't know about. Each handler is `(sql, values) =>
 * result|undefined`; the first one to return non-undefined wins.
 */
class FakeBulkOpsPool {
  constructor({ extraHandlers = [] } = {}) {
    this.bulkOps = new Map();
    this.extraHandlers = extraHandlers;
  }

  async query(sql, values = []) {
    const s = sql.replace(/\s+/g, " ").trim();

    if (s === "BEGIN" || s === "COMMIT" || s === "ROLLBACK") {
      return { rows: [] };
    }

    if (s.startsWith("INSERT INTO bulk_ops")) {
      const [
        id, type, params, params_hash, filters, scope_ids,
        preview_count, sample, destructive, created_by, expires_at,
      ] = values;
      const row = {
        id, type,
        params: JSON.parse(params),
        params_hash,
        filters: JSON.parse(filters),
        scope_ids: JSON.parse(scope_ids),
        preview_count,
        sample: JSON.parse(sample),
        destructive,
        status: "preview",
        created_by,
        confirmed_by: null,
        outcomes: null,
        error: null,
        created_at: new Date(),
        expires_at: new Date(expires_at),
        started_at: null,
        finished_at: null,
      };
      this.bulkOps.set(id, row);
      return { rows: [{ ...row }] };
    }

    if (s.startsWith("UPDATE bulk_ops SET status = 'expired'")) {
      const row = this.bulkOps.get(values[0]);
      if (row && row.status === "preview") {
        row.status = "expired";
        return { rows: [{ ...row }] };
      }
      return { rows: [] };
    }

    if (s.startsWith("UPDATE bulk_ops SET status = 'confirmed'")) {
      const [id, confirmedBy] = values;
      const row = this.bulkOps.get(id);
      if (row && row.status === "preview" && row.expires_at.getTime() >= Date.now()) {
        row.status = "confirmed";
        row.confirmed_by = confirmedBy;
        row.started_at = new Date();
        return { rows: [{ ...row }] };
      }
      return { rows: [] };
    }

    if (s.startsWith("UPDATE bulk_ops SET status = $2, outcomes = $3")) {
      const [id, status, outcomes] = values;
      const row = this.bulkOps.get(id);
      row.status = status;
      row.outcomes = JSON.parse(outcomes);
      row.finished_at = new Date();
      return { rows: [{ ...row }] };
    }

    if (s.startsWith("UPDATE bulk_ops SET status = 'failed', error = $2")) {
      const [id, error] = values;
      const row = this.bulkOps.get(id);
      if (row) {
        row.status = "failed";
        row.error = error;
        row.finished_at = new Date();
      }
      return { rows: row ? [{ ...row }] : [] };
    }

    if (s.startsWith("UPDATE bulk_ops SET status = 'cancelled'")) {
      const row = this.bulkOps.get(values[0]);
      if (row && row.status === "preview") {
        row.status = "cancelled";
        return { rows: [{ ...row }] };
      }
      return { rows: [] };
    }

    if (s.startsWith("SELECT * FROM bulk_ops") && s.includes("ORDER BY created_at DESC LIMIT")) {
      let rows = [...this.bulkOps.values()];
      let vi = 0;
      if (s.includes("status = $")) {
        rows = rows.filter((r) => r.status === values[vi]);
        vi++;
      }
      if (s.includes("type = $")) {
        rows = rows.filter((r) => r.type === values[vi]);
        vi++;
      }
      rows.sort((a, b) => b.created_at - a.created_at);
      return { rows: rows.map((r) => ({ ...r })) };
    }

    if (s === "SELECT * FROM bulk_ops WHERE id = $1") {
      const row = this.bulkOps.get(values[0]);
      return { rows: row ? [{ ...row }] : [] };
    }

    for (const handler of this.extraHandlers) {
      const result = handler(s, values);
      if (result !== undefined) return result;
    }

    throw new Error(`FakeBulkOpsPool: unhandled query: ${s}`);
  }

  async connect() {
    return {
      query: (sql, values) => this.query(sql, values),
      release: () => {},
    };
  }
}

module.exports = { FakeBulkOpsPool };
