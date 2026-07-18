"use strict";

/**
 * 013_project_search
 *
 * Adds a `search_vector` tsvector column to `projects` so GET /api/projects
 * can rank full-text search results with PostgreSQL's built-in relevance
 * scoring (ts_rank) instead of relying solely on ILIKE substring matches.
 *
 * Weighted so a match in `name` outranks one only in `description`:
 *   A: name          B: location, tags          C: description
 *
 * A BEFORE INSERT OR UPDATE trigger keeps the column current; up() also
 * backfills every existing row since the trigger only fires going forward.
 */
module.exports = {
  name: "013_project_search",

  async up(client) {
    await client.query(
      "ALTER TABLE projects ADD COLUMN IF NOT EXISTS search_vector tsvector",
    );
    await client.query(
      "CREATE INDEX IF NOT EXISTS projects_search_idx ON projects USING GIN(search_vector)",
    );

    await client.query(`
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
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS project_search_update ON projects
    `);
    await client.query(`
      CREATE TRIGGER project_search_update
        BEFORE INSERT OR UPDATE ON projects
        FOR EACH ROW EXECUTE FUNCTION update_project_search_vector()
    `);

    await client.query(`
      UPDATE projects SET search_vector =
        setweight(to_tsvector('english', COALESCE(name, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(location, '') || ' ' || array_to_string(tags, ' ')), 'B') ||
        setweight(to_tsvector('english', COALESCE(description, '')), 'C')
    `);
  },

  async down(client) {
    await client.query("DROP TRIGGER IF EXISTS project_search_update ON projects");
    await client.query("DROP FUNCTION IF EXISTS update_project_search_vector()");
    await client.query("DROP INDEX IF EXISTS projects_search_idx");
    await client.query("ALTER TABLE projects DROP COLUMN IF EXISTS search_vector");
  },
};
