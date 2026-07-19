-- projects: core project registry. Central entity; every other table
-- references projects.id. Status lifecycle: active → completed / cancelled.
-- on_chain_verified reflects Stellar anchor verification.
-- raised_xlm / donor_count / co2_offset_kg are summary counters updated by triggers.
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  location TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  goal_xlm NUMERIC(20, 7) NOT NULL DEFAULT 0,
  raised_xlm NUMERIC(20, 7) NOT NULL DEFAULT 0,
  donor_count INTEGER NOT NULL DEFAULT 0,
  co2_offset_kg INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  on_chain_verified BOOLEAN NOT NULL DEFAULT FALSE,
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- AI summary cache: filled on demand by POST /api/projects/:id/generate-summary,
-- read by GET /api/projects/:id and rendered as a highlighted card on the
-- project detail page. ai_summary_source_hash stores a SHA-256 of the
-- description that produced the summary so the UI can show a "needs refresh"
-- hint when the description has been edited since.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS ai_summary             TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS ai_summary_generated_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS ai_summary_model        TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS ai_summary_source_hash  TEXT;

-- Webhook notification support: project owners can register a URL that receives
-- signed POSTs when donation milestones are reached.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS webhook_url    TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS webhook_secret TEXT;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS webhook_url    TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS webhook_secret TEXT;

-- Geocoded coordinates for project.location, resolved server-side by
-- services/geocoder.js at creation time. NULL until successfully geocoded.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS latitude  DOUBLE PRECISION;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
CREATE INDEX IF NOT EXISTS idx_projects_location ON projects (latitude, longitude);

-- Path-payment donations: track source asset and conversion details for
-- donations made via any Stellar asset converted to XLM through the DEX.
ALTER TABLE donations ADD COLUMN IF NOT EXISTS source_asset        TEXT;
ALTER TABLE donations ADD COLUMN IF NOT EXISTS conversion_path     JSONB;
ALTER TABLE donations ADD COLUMN IF NOT EXISTS converted_amount_xlm NUMERIC(20, 7);
CREATE INDEX IF NOT EXISTS idx_donations_source_asset ON donations (source_asset) WHERE source_asset IS NOT NULL;

-- Automated CO₂ offset-rate verification (see migration 018 and
-- services/co2Verifier.js). Self-reported co2_per_xlm rates are compared
-- against per-category industry benchmarks when a verification request is
-- approved; the verdict lands here. Statuses: pending (not yet checked),
-- verified (≤3× benchmark), review (3–10×), flagged (>10×, needs admin
-- resolution), rejected (admin rejected the claimed rate).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS co2_verification_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS co2_verification_notes TEXT;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_co2_verification_status_check;
ALTER TABLE projects ADD CONSTRAINT projects_co2_verification_status_check
  CHECK (co2_verification_status IN ('pending', 'verified', 'review', 'flagged', 'rejected'));
CREATE INDEX IF NOT EXISTS idx_projects_co2_verification_status
  ON projects (co2_verification_status)
  WHERE co2_verification_status IN ('review', 'flagged');

-- Full-text search: tsvector kept current by a trigger (see migration
-- 013_project_search) so GET /api/projects can rank matches with ts_rank
-- instead of relying solely on ILIKE substring matching.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS search_vector tsvector;
CREATE INDEX IF NOT EXISTS projects_search_idx ON projects USING GIN(search_vector);

CREATE OR REPLACE FUNCTION update_project_search_vector()
RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.name, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.location, '') || ' ' || array_to_string(NEW.tags, ' ')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS project_search_update ON projects;
CREATE TRIGGER project_search_update
  BEFORE INSERT OR UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION update_project_search_vector();

-- donations: immutable donation ledger. Each row is a single
-- contribution from donor_address to a project. transaction_hash must be
-- unique (one Stellar payment → one donation). No updated_at column —
-- records are never mutated after insert.
CREATE TABLE IF NOT EXISTS donations (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  donor_address TEXT NOT NULL,
  amount_xlm NUMERIC(20, 7),
  amount NUMERIC(20, 7) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'XLM',
  message TEXT,
  transaction_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- profiles: aggregated donor stats and public profile for a Stellar wallet.
-- total_donated_xlm and projects_supported are computed counters kept in
-- sync by triggers on donations. badges is a JSONB array of earned badge IDs.
CREATE TABLE IF NOT EXISTS profiles (
  public_key TEXT PRIMARY KEY,
  display_name TEXT,
  bio TEXT,
  total_donated_xlm NUMERIC(20, 7) NOT NULL DEFAULT 0,
  projects_supported INTEGER NOT NULL DEFAULT 0,
  badges JSONB NOT NULL DEFAULT '[]'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

-- project_updates: news / blog posts published by project owners. Listed
-- on the project detail page in reverse chronological order.
CREATE TABLE IF NOT EXISTS project_updates (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- project_subscriptions: email-based subscriptions to project updates.
-- UNIQUE(project_id, email) prevents duplicate sign-ups.
CREATE TABLE IF NOT EXISTS project_subscriptions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  donor_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, email)
);

-- jobs: freelance jobs using Stellar escrow. Client deposits
-- amount_escrow_xlm; the job sits in_escrow until the client releases funds
-- (release_transaction_hash is set), transitioning to released. The escrow
-- pattern ties Stellar payment lifecycles to off-chain job completion.
CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  client_public_key TEXT NOT NULL,
  freelancer_public_key TEXT NOT NULL,
  amount_escrow_xlm NUMERIC(20, 7) NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_escrow',
  release_transaction_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- project_campaigns: time-boxed fundraising campaigns for a project,
-- each with its own goal and deadline.
CREATE TABLE IF NOT EXISTS project_campaigns (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  goal_xlm NUMERIC(20, 7) NOT NULL,
  deadline TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- project_milestones: percentage-based funding milestones for a project.
-- reached_at + transaction_hash are set when the milestone is met on-chain.
CREATE TABLE IF NOT EXISTS project_milestones (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  percentage INTEGER NOT NULL,
  title TEXT NOT NULL,
  reached_at TIMESTAMPTZ,
  transaction_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- project_ratings: 1-5 star ratings with optional review from donors.
-- UNIQUE(project_id, donor_address) ensures one rating per donor per project.
CREATE TABLE IF NOT EXISTS project_ratings (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  donor_address TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  review TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, donor_address)
);

-- donation_matches: matching offer contracts. A matcher pledges to multiply
-- donations up to cap_xlm by multiplier (e.g. 2×). matched_xlm tracks the
-- total matched so far; expires_at ends the offer period.
CREATE TABLE IF NOT EXISTS donation_matches (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  matcher_address TEXT NOT NULL,
  cap_xlm NUMERIC(20, 7) NOT NULL,
  multiplier INTEGER NOT NULL DEFAULT 1,
  expires_at TIMESTAMPTZ NOT NULL,
  matched_xlm NUMERIC(20, 7) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- idempotency_keys: stores response snapshots keyed by Idempotency-Key
-- headers so safe retries of POST /api/donations replay the original
-- response instead of creating duplicate donation records. Keys expire
-- after 24 hours and are cleaned up by a background job.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  request_body_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);
CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys (expires_at);

-- device_tokens: push notification device registrations. token is the FCM /
-- APNs device token; platform is 'ios' or 'android'. wallet_address links
-- the device to a profile when known.
CREATE TABLE IF NOT EXISTS device_tokens (
  id UUID PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  wallet_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- project_follows: many-to-many join between projects and device_tokens.
-- A device "follows" a project to receive push notifications.
-- UNIQUE(project_id, device_token_id) prevents duplicate follows.
CREATE TABLE IF NOT EXISTS project_follows (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  device_token_id UUID NOT NULL REFERENCES device_tokens(id) ON DELETE CASCADE,
  wallet_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, device_token_id)
);

-- Verification requests submitted via the /apply form on the frontend.
-- Each row represents an organisation asking the IndigoPay admin team to
-- verify their climate project. Mirrors the columns of migration 002.
CREATE TABLE IF NOT EXISTS verification_requests (
  id UUID PRIMARY KEY,
  organization_name TEXT NOT NULL,
  organization_website TEXT,
  organization_country TEXT,
  contact_email TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  project_name TEXT NOT NULL,
  project_category TEXT NOT NULL,
  project_location TEXT NOT NULL,
  project_description TEXT,
  co2_per_xlm NUMERIC(20, 7) NOT NULL,
  expected_annual_tonnes_co2 NUMERIC(20, 7),
  supporting_documents JSONB NOT NULL DEFAULT '[]'::JSONB,
  storage_backend TEXT NOT NULL DEFAULT 'local',
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewer_notes TEXT,
  reviewed_by TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  CONSTRAINT verification_requests_status_check
    CHECK (status IN ('pending', 'in_review', 'approved', 'rejected')),
  CONSTRAINT verification_requests_co2_positive
    CHECK (co2_per_xlm >= 0)
);
CREATE INDEX IF NOT EXISTS verification_requests_status_idx
  ON verification_requests (status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS verification_requests_wallet_idx
  ON verification_requests (wallet_address);

-- idempotency_keys: stores the cached HTTP response for each Idempotency-Key
-- header value sent by clients to POST /api/donations.  Rows older than 24 h
-- are pruned by the idempotencyCleanup cron service so that retried requests
-- within the same window always receive the same response body and status code.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key              TEXT        PRIMARY KEY,
  response_status  INTEGER     NOT NULL,
  response_body    JSONB       NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idempotency_keys_created_at_idx
  ON idempotency_keys (created_at);
