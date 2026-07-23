-- Postgres grants EXECUTE to PUBLIC by default, and anon/authenticated inherit
-- through PUBLIC membership — revoking from the two roles directly wasn't
-- enough. Revoke from PUBLIC itself so only the function owner (used by the
-- auth.users trigger) can call it.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC;
