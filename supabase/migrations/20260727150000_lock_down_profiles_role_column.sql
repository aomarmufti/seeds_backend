-- CRITICAL SECURITY FIX: the RLS policies added in
-- 20260712012907_lock_down_rls_and_fix_profile_schema.sql restrict *rows*
-- (id = auth.uid()) but never restricted which *columns* a caller can
-- write on their own row. Since lib/auth.js's requireAdmin/requireAuth
-- trust whatever value is stored in profiles.role with no independent
-- check, any authenticated user could grant themselves admin (or tutor)
-- access with a single client-side call:
--   sbClient.from('profiles').update({ role: 'admin' }).eq('id', myId)
-- This was live in production. Confirmed empirically on a throwaway
-- staging row, impersonating the `authenticated` Postgres role with a
-- forged request.jwt.claims GUC (SET ROLE authenticated; SET
-- request.jwt.claims; UPDATE ... SET role='admin' — succeeded).
--
-- Two things that look like fixes but do NOT work here, both confirmed
-- empirically rather than assumed, and worth recording so nobody retries
-- them later:
--   1. `revoke update (role) on profiles from authenticated` — Supabase
--      grants `authenticated` a blanket table-level UPDATE on every
--      public table by default (RLS is meant to be the real gate), and
--      that table-level grant supersedes a column-level revoke.
--   2. An RLS `with check` clause comparing NEW.role against the row's
--      existing value via `role = (select role from profiles where
--      id = auth.uid())` — the subquery sees this same UPDATE's own
--      in-flight new value rather than the pre-update one, so the
--      comparison is always true and never blocks anything.
--
-- The reliable fix is a BEFORE UPDATE trigger, which gets real OLD/NEW
-- row versions with no snapshot ambiguity: reject any attempt to change
-- role unless the caller is the backend's service-role connection
-- (auth.role() = 'service_role'), which is how api/auth.js's
-- deactivate-tutor and admin-provisioning flows write role changes.
create or replace function public.prevent_role_self_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role and auth.role() <> 'service_role' then
    raise exception 'Changing role is not permitted for this caller';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_prevent_role_escalation on public.profiles;
create trigger profiles_prevent_role_escalation
  before update on public.profiles
  for each row execute function public.prevent_role_self_escalation();

-- The UPDATE policy stays exactly as originally defined (row ownership
-- only) — the trigger above is the actual role guard now, so there's no
-- need for (and, per the finding above, no reliable way to write) a
-- column-level restriction inside the policy itself.
drop policy if exists "authenticated users update own profile" on public.profiles;
create policy "authenticated users update own profile"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Defense in depth for the INSERT path (the "Request access" signup
-- screen's client-side upsert, and any other future client-side insert):
-- even a fresh row a user is allowed to create can only ever be
-- self-provisioned as student or pending, never tutor/admin/deactivated.
drop policy if exists "authenticated users insert own profile" on public.profiles;
create policy "authenticated users insert own profile"
  on public.profiles for insert
  to authenticated
  with check (id = auth.uid() and role in ('student', 'pending'));

-- Revert the earlier, ineffective column-level revoke attempt (harmless
-- but pointless to leave in place now that the trigger is the real gate).
grant update (role) on public.profiles to authenticated;
