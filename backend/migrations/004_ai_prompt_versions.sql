-- UP
CREATE TABLE IF NOT EXISTS prompt_versions (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  model TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_versions_one_active
  ON prompt_versions (active) WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS ai_summary_calls (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  called_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  requested_by TEXT,
  outcome TEXT NOT NULL DEFAULT 'queued',
  prompt_version_id UUID REFERENCES prompt_versions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_summary_calls_project_called
  ON ai_summary_calls(project_id, called_at DESC);

-- DOWN
DROP TABLE IF EXISTS ai_summary_calls;
DROP TABLE IF EXISTS prompt_versions;

