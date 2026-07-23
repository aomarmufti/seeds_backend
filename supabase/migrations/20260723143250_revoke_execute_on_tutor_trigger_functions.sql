-- Supabase's default privileges on the public schema grant EXECUTE directly
-- to anon/authenticated (not just via PUBLIC) for every new function, so
-- revoking from PUBLIC alone (as tried first) isn't sufficient — confirmed
-- via has_function_privilege() still returning true for both roles after
-- that revoke. Revoke explicitly from all three.
REVOKE EXECUTE ON FUNCTION public.set_tutor_id_from_name() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.propagate_tutor_rename() FROM PUBLIC, anon, authenticated;
