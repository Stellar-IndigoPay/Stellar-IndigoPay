// "use strict";

module.exports = {
  name: "009_impact_tables",

  async up(client) {
    // donor_impact table (one row per donor wallet address)
    await client.query(`
      CREATE TABLE IF NOT EXISTS donor_impact (
        wallet_address TEXT PRIMARY KEY,
        total_donated_xlm NUMERIC(20,7) NOT NULL DEFAULT 0,
        total_co2_kg NUMERIC(20,7) NOT NULL DEFAULT 0,
        total_trees NUMERIC(20,7) NOT NULL DEFAULT 0,
        projects_supported INTEGER NOT NULL DEFAULT 0,
        badge_tier TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // global_impact single‑row table
    await client.query(`
      CREATE TABLE IF NOT EXISTS global_impact (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        total_donated_xlm NUMERIC(20,7) NOT NULL DEFAULT 0,
        total_co2_kg NUMERIC(20,7) NOT NULL DEFAULT 0,
        total_trees NUMERIC(20,7) NOT NULL DEFAULT 0,
        total_donations INTEGER NOT NULL DEFAULT 0,
        total_projects INTEGER NOT NULL DEFAULT 0,
        total_donors INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Insert the single row if it does not exist
    await client.query(`
      INSERT INTO global_impact (id) VALUES (1)
      ON CONFLICT (id) DO NOTHING;
    `);

    // impact_recalculation_log for idempotent processing
    await client.query(`
      CREATE TABLE IF NOT EXISTS impact_recalculation_log (
        id SERIAL PRIMARY KEY,
        donation_id UUID NOT NULL,
        project_id UUID NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('processing','completed','failed')),
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Index for fast lookup by donation_id
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_impact_log_donation_id ON impact_recalculation_log (donation_id);
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS impact_recalculation_log`);
    await client.query(`DROP TABLE IF EXISTS global_impact`);
    await client.query(`DROP TABLE IF EXISTS donor_impact`);
  },
};
