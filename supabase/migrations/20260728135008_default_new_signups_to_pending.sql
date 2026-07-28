-- SCRUM-78: handle_new_user() defaulted role to 'student' for any account
-- with no explicit role in raw_user_meta_data. The one signup path that
-- passes role='pending' (the public "Request access" form) was fine, but
-- signInWithOtp's magic-link path passes no metadata at all, so a brand-new
-- email using it landed straight in a working student portal with zero
-- admin review and no leads row to catch it — invisible to the Students/
-- Leads admin views, which both key off leads/students, not profiles.
-- Defaulting to 'pending' closes this for every current and future
-- unreviewed entry point (magic link, and Google sign-in once enabled).
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
    coalesce(new.raw_user_meta_data->>'role', 'pending'),
    coalesce(new.raw_user_meta_data->>'full_name', '')
  );
  return new;
end;
$function$;
