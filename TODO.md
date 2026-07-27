# TODO - GF-041 Migration Framework (SQL + rollback)

- [ ] 1) Add SQL migration files under `backend/migrations/` (001..004) with `-- UP` and `-- DOWN` converted from existing JS migrations.
- [x] 2) Rewrite `backend/src/db/migrate.js` to use SQL migrations and `_migrations` history w/ checksum + per-migration transaction rollback.

- [x] 3) Add/replace `backend/scripts/migrate.js` CLI: `up|down|status|create`.

- [x] 4) Add Jest tests for migration apply/skip, failure rollback, rollback deletes history, checksum behavior.

- [ ] 5) Update `.github/workflows/backend.yml` to run migration verification on clean DB.
- [ ] 6) Run `cd backend && npm test` and (optionally) run CLI smoke commands.

