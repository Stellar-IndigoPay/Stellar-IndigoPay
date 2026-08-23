CREATE TABLE IF NOT EXISTS project_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  donor_address VARCHAR(56) NOT NULL,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  review TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, donor_address)
);

CREATE INDEX IF NOT EXISTS idx_project_ratings_project_id ON project_ratings(project_id);
CREATE INDEX IF NOT EXISTS idx_project_ratings_donor_address ON project_ratings(donor_address);
