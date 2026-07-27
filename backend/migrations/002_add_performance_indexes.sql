-- UP
CREATE INDEX CONCURRENTLY idx_donations_project_created ON donations(project_id, created_at DESC);
CREATE INDEX CONCURRENTLY idx_profiles_donated ON profiles(total_donated_xlm DESC);
CREATE INDEX CONCURRENTLY idx_projects_status_donor ON projects(status, donor_count DESC);

-- DOWN
DROP INDEX CONCURRENTLY IF EXISTS idx_projects_status_donor;
DROP INDEX CONCURRENTLY IF EXISTS idx_profiles_donated;
DROP INDEX CONCURRENTLY IF EXISTS idx_donations_project_created;

