-- UP
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT webhook_deliveries_status_check CHECK (
    status IN ('pending','delivered','failed','dlq')
  )
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_project
  ON webhook_deliveries(project_id);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status_next
  ON webhook_deliveries(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS webhook_dlq (
  id UUID PRIMARY KEY,
  delivery_id UUID NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  failure_reason TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_dlq_project
  ON webhook_dlq(project_id);

CREATE INDEX IF NOT EXISTS idx_webhook_dlq_created
  ON webhook_dlq(created_at);

-- DOWN
DROP TABLE IF EXISTS webhook_dlq;
DROP TABLE IF EXISTS webhook_deliveries;

