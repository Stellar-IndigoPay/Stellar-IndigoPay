"use strict";

const fs = require("fs");
const path = require("path");

const { runMigrations, rollbackMigration, getMigrationStatus } =
  require("../src/db/migrate");

function usage() {
  console.log(`Usage:
  node backend/scripts/migrate.js up
  node backend/scripts/migrate.js down <migration_file.sql>
  node backend/scripts/migrate.js down --steps <n>
  node backend/scripts/migrate.js status
  node backend/scripts/migrate.js create <name>

Examples:
  node backend/scripts/migrate.js down 003_webhook_deliveries.sql
  node backend/scripts/migrate.js down --steps 1
  node backend/scripts/migrate.js create add_donor_notes
`);
}

function normalizeCreateName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_\-]/g, "")
    .slice(0, 80);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  switch (cmd) {
    case "up":
      await runMigrations();
      break;

    case "down": {
      const maybeFile = args[1];
      const stepsIdx = args.indexOf("--steps");
      if (stepsIdx !== -1) {
        const steps = parseInt(args[stepsIdx + 1], 10);
        if (!Number.isFinite(steps) || steps < 1) {
          throw new Error("Invalid --steps value. Must be an integer >= 1");
        }
        await rollbackMigration({ steps });
      } else {
        if (!maybeFile) {
          usage();
          process.exit(1);
        }
        const fileName = path.basename(maybeFile);
        await rollbackMigration({ name: fileName });
      }
      break;
    }

    case "status": {
      const status = await getMigrationStatus();
      if (status.length === 0) {
        console.log("No migrations have been applied.");
      } else {
        // eslint-disable-next-line no-console
        console.table(
          status.map((r) => ({
            id: r.id,
            name: r.name,
            applied_at: r.applied_at,
            checksum: r.checksum,
          }))
        );
      }
      break;
    }

    case "create": {
      const name = normalizeCreateName(args[1]);
      if (!name) {
        usage();
        process.exit(1);
      }

      const migrationsDir = path.join(__dirname, "../../migrations");
      if (!fs.existsSync(migrationsDir)) fs.mkdirSync(migrationsDir, { recursive: true });

      const timestamp = Date.now();
      const fileName = `${timestamp}_${name}.sql`;
      const filePath = path.join(migrationsDir, fileName);

      const content = `-- UP\n\n-- DOWN\n\n`;
      fs.writeFileSync(filePath, content, "utf8");
      console.log(`Created migration: migrations/${fileName}`);
      break;
    }

    default:
      usage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Migration CLI failed:", err.message);
  process.exit(1);
});

