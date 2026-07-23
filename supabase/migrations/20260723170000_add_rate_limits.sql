-- SCRUM-20: rate limiting on public-facing endpoints (leads, payment/setup
-- intent creation, booking confirm) without introducing a new third-party
-- service (Upstash/Redis) — Supabase is already the platform's database, and
-- an atomic INSERT ... ON CONFLICT DO UPDATE gives correct behaviour even
-- across concurrent serverless invocations, which a naive in-memory counter
-- on Vercel functions could not (no shared state between instances/cold
-- starts).
CREATE TABLE public.rate_limits (
  key text primary key,
  count integer not null default 1,
  window_start timestamptz not null default now()
);

ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

-- No policies are added — RLS with zero policies denies all access via the
-- anon/authenticated roles by default. Only the service-role backend (which
-- bypasses RLS) reads/writes this table, via the RPC function below.
CREATE OR REPLACE FUNCTION public.check_rate_limit(p_key text, p_max integer, p_window_seconds integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO public.rate_limits (key, count, window_start)
  VALUES (p_key, 1, now())
  ON CONFLICT (key) DO UPDATE SET
    count = CASE
      WHEN public.rate_limits.window_start < now() - (p_window_seconds || ' seconds')::interval
        THEN 1
      ELSE public.rate_limits.count + 1
    END,
    window_start = CASE
      WHEN public.rate_limits.window_start < now() - (p_window_seconds || ' seconds')::interval
        THEN now()
      ELSE public.rate_limits.window_start
    END
  RETURNING count INTO v_count;

  RETURN v_count <= p_max;
END;
$function$;

-- Trigger-style lockdown (SCRUM-47 pattern): this function is only ever
-- meant to be called by the backend's service-role key via PostgREST RPC,
-- never directly by anon/authenticated clients.
REVOKE EXECUTE ON FUNCTION public.check_rate_limit(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(text, integer, integer) TO service_role;
