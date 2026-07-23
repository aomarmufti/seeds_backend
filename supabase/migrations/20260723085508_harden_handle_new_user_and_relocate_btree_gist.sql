-- SCRUM-47: lock down handle_new_user (signup trigger) and relocate btree_gist out of public

-- 1. Pin search_path so the function can't be tricked by a mutable search_path,
--    and mark it as a pure signup trigger (not a public RPC).
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
begin
  insert into profiles (id, email, role, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'role', 'student'),
    coalesce(new.raw_user_meta_data->>'full_name', '')
  );
  return new;
end;
$function$;

-- 2. This function is only ever invoked by the auth.users insert trigger
--    (which runs via the Supabase auth service, not via PostgREST as anon/
--    authenticated). Revoke direct RPC-callable EXECUTE so it can't be
--    invoked as a public endpoint.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated;

-- 3. Move btree_gist out of the public schema into the dedicated
--    "extensions" schema already used for pgcrypto/uuid-ossp, per
--    Supabase's extension_in_public advisory. Operator class references in
--    existing indexes (e.g. bookings_no_tutor_overlap) are OID-based, not
--    schema-qualified, so this does not break the exclusion constraint.
ALTER EXTENSION btree_gist SET SCHEMA extensions;
