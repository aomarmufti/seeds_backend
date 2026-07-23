CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  actor text not null,
  action text not null,
  target_type text,
  target_id text,
  details jsonb
);
ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;
