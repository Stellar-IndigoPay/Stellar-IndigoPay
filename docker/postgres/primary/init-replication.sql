-- docker/postgres/primary/init-replication.sql
-- Creates the replication user when the primary container first starts.
-- This avoids needing to run setup-replication.sh for local dev.

DO
$$
BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_catalog.pg_roles WHERE rolname = 'replicator'
  ) THEN
    CREATE ROLE replicator WITH LOGIN REPLICATION PASSWORD 'replicator';
  END IF;
END
$$;

-- Allow replication connections from any host in the docker network
ALTER SYSTEM SET wal_level = 'replica';
SELECT pg_reload_conf();
