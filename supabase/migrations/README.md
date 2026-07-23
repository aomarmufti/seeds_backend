# Applying these migrations to a fresh Supabase project

1. Install the Supabase CLI and log in: `npx supabase login`
2. Link this repo to the target project: `npx supabase link --project-ref <project-ref>`
   (update `project_id` in `supabase/config.toml` to match, or pass `--project-ref` each time)
3. Apply all migrations in order: `npx supabase db push`

Migrations are plain timestamped `.sql` files applied in filename order.
`20260701000000_baseline_schema_snapshot.sql` recreates the original
tables (reconstructed from live introspection, since the real originals
predate migration tracking); everything after it is copied verbatim from
this project's own migration history.

New schema changes should be added as a new `supabase/migrations/<timestamp>_<name>.sql`
file rather than applied ad hoc, so the migrations directory stays the
source of truth.
