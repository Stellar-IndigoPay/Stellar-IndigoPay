"use strict";

/**
 * 027_digest_sends
 * NOTE: verify this is the next free migration number in
 * backend/src/db/migrations/ before applying — rename the file (and the
 * `name` field below) if a higher-numbered migration already exists.
 *
 * Per-recipient, per-period idempotency guard for the impact-digest email
 * pipeline (services/digestQueue.js).
 *
 * Without this, a retried queue job (or any code path that invokes
 * runDigest() twice for the same period — including the "no pg-boss
 * instance in this process" fallback in enqueueDigest(), which bypasses
 * the queue entirely) re-sends the digest email to every recipient who
 * already received it.
 *
 * Before sending, the queue claims a row here via
 * INSERT ... ON CONFLICT (digest_type, donor_address, period_start)
 * DO NOTHING. Whichever invocation's INSERT wins the race gets to send;
 * every other invocation — no matter how it was triggered — loses the
 * race and skips that recipient instead of dispatching a duplicate email.
 *
 * status: 'sending' (claimed, send in flight) -> 'sent' | 'failed'.
 * A 'failed' row may be re-claimed by a later run, up to a small retry
 * cap enforced in digestQueue.js. A 'sending' row stuck past a staleness
 * window is assumed to belong to a worker that crashed mid-send and may
 * also be re-claimed.
 */

module.exports = {
  name: "027_digest_sends",

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS digest_sends (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        digest_type    TEXT NOT NULL,
        donor_address  TEXT NOT NULL,
        period_start   TIMESTAMPTZ NOT NULL,
        period_end     TIMESTAMPTZ,
        status         TEXT NOT NULL DEFAULT 'sending',
        attempts       INTEGER NOT NULL DEFAULT 1,
        last_error     TEXT,
        claimed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sent_at        TIMESTAMPTZ,
        CONSTRAINT digest_sends_status_check
          CHECK (status IN ('sending', 'sent', 'failed')),
        CONSTRAINT digest_sends_unique_recipient_period
          UNIQUE (digest_type, donor_address, period_start)
      )
    `);

    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_digest_sends_status ON digest_sends (digest_type, period_start, status)",
    );
  },

  async down(client) {
    await client.query("DROP TABLE IF EXISTS digest_sends");
  },
};