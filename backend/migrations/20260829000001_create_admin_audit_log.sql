-- Migration: create admin_audit_log table
-- Issue #1128 (Part A — supersedes #1084)
--
-- Stores an append-only tamper-evident log of every admin mutation.
-- The table MUST NOT be modified after insert: an immutability trigger
-- blocks UPDATE and DELETE at the database level so no application bug
-- or compromised connection can silently alter historical records.
--
-- Hash-chain columns (prev_hash, row_hash) are added here so the
-- chain can be established from the very first row. The auditChain.js
-- service computes and verifies the chain in application code.

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  actor         TEXT          NOT NULL,
  action        TEXT          NOT NULL,
  resource_type TEXT,
  resource_id   TEXT,
  -- Semantic before/after snapshots of the mutated resource so reviewers
  -- can see exactly what changed without consulting a separate data store.
  before_state  JSONB,
  after_state   JSONB,
  -- Legacy catch-all metadata bucket retained for backward compat with
  -- the existing auditMiddleware writer; new writers should prefer the
  -- typed before_state / after_state columns above.
  metadata      JSONB         NOT NULL DEFAULT '{}',
  ip_address    TEXT,
  user_agent    TEXT,
  -- Hash-chain fields for tamper-evidence (see services/auditChain.js).
  prev_hash     TEXT,
  row_hash      TEXT,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- target_type / target_id are aliases accepted by the existing
-- audit.js writer — expose them as generated columns so both the
-- new resource_type/resource_id names and the legacy names work
-- without duplicating storage.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'admin_audit_log' AND column_name = 'target_type'
  ) THEN
    ALTER TABLE admin_audit_log
      ADD COLUMN target_type TEXT GENERATED ALWAYS AS (resource_type) STORED;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'admin_audit_log' AND column_name = 'target_id'
  ) THEN
    ALTER TABLE admin_audit_log
      ADD COLUMN target_id TEXT GENERATED ALWAYS AS (resource_id) STORED;
  END IF;
END;
$$;

-- Indexes for the most common filter shapes used by GET /api/admin/audit-log.
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_actor
    ON admin_audit_log (actor);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action
    ON admin_audit_log (action);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_resource
    ON admin_audit_log (resource_type, resource_id)
    WHERE resource_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at
    ON admin_audit_log (created_at DESC);

-- ── Immutability trigger ───────────────────────────────────────────────────
-- Prevent UPDATE and DELETE on every row.  A rule-based approach (CREATE
-- RULE) would be cleaner but triggers are more portable across Postgres
-- versions and easier to test.

CREATE OR REPLACE FUNCTION admin_audit_log_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'admin_audit_log is append-only: UPDATE and DELETE are not permitted (row id: %)',
    COALESCE(OLD.id::text, '?');
END;
$$;

DROP TRIGGER IF EXISTS admin_audit_log_no_update ON admin_audit_log;
CREATE TRIGGER admin_audit_log_no_update
  BEFORE UPDATE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION admin_audit_log_immutable();

DROP TRIGGER IF EXISTS admin_audit_log_no_delete ON admin_audit_log;
CREATE TRIGGER admin_audit_log_no_delete
  BEFORE DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION admin_audit_log_immutable();

-- ── Anchor table ───────────────────────────────────────────────────────────
-- Supports hash-chain verification after data-retention pruning.  The
-- retention worker records the prev_hash of the oldest surviving row here
-- before it purges so verifyChain() can resume from the correct starting
-- point.  See services/auditChain.js for the full explanation.

CREATE TABLE IF NOT EXISTS audit_chain_anchor (
  id            INTEGER       PRIMARY KEY DEFAULT 1,
  anchor_hash   TEXT          NOT NULL,
  anchor_row_id UUID,
  anchored_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  reason        TEXT
);
