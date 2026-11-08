# Database migrations

Two folders hold SQL migrations for the Supabase database. Apply them in this order:

1. `migrations/` — the original season, award, retention and clan-health schema (timestamped `YYYYMMDDHHMMSS_*.sql`).
2. `supabase/migrations/` — later rival-momentum and forecast-accuracy changes (`YYYYMMDDNNNN_*.sql`); these depend on the tables above.

Within each folder, apply files in filename order. Run them in the Supabase SQL editor or with the Supabase CLI. Migrations are not applied automatically on deploy.

## Required environment variables (Vercel)

- `CRON_SECRET` — **required**. `/api/tick` returns 500 if unset. Send it as `Authorization: Bearer <secret>` (preferred) or `?key=<secret>`.
- Supabase and Discord credentials as referenced in `api/_lib.js` and `api/interactions.js`.

## Tests

`npm test` runs the unit tests in `tests/`.
