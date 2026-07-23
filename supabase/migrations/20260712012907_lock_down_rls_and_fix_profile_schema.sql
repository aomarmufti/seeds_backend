-- 1. Add profile columns the frontend already reads/writes but which don't exist yet
--    (student profile completion, profile view, and tutor profile editing are
--    currently failing silently against these missing columns)
alter table public.profiles
  add column if not exists school_year text,
  add column if not exists target_grades jsonb,
  add column if not exists subjects text,
  add column if not exists onboarding_complete boolean default false,
  add column if not exists bio text;

-- 2. Allow 'deactivated' as a role value — api/auth.js's deactivate-tutor action
--    writes this and currently fails the check constraint
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role = any (array['student'::text, 'tutor'::text, 'admin'::text, 'pending'::text, 'deactivated'::text]));

-- 3. Remove the blanket "allow everyone" RLS policies. Safe: the backend uses the
--    Supabase service-role key, which bypasses RLS entirely regardless of policy,
--    so none of the api/*.js endpoints are affected. This only removes the ability
--    for the anon/authenticated (browser) key to read/write these tables directly.
drop policy if exists "service full access bookings" on public.bookings;
drop policy if exists "service full access homework" on public.homework;
drop policy if exists "service full access leads" on public.leads;
drop policy if exists "service full access lesson_notes" on public.lesson_notes;
drop policy if exists "service notes" on public.lesson_notes;
drop policy if exists "service full access messages" on public.messages;
drop policy if exists "service full access payout_items" on public.payout_items;
drop policy if exists "service full access payouts" on public.payouts;
drop policy if exists "service full access profiles" on public.profiles;
drop policy if exists "service full access progress" on public.progress;
drop policy if exists "service full access students" on public.students;
drop policy if exists "service tutor_accounts" on public.tutor_accounts;

-- 4. Narrow, scoped replacement for profiles only: the frontend calls
--    sbClient.from('profiles').select/update/upsert(...).eq('id', session.user.id)
--    directly (profile completion, profile view, onboarding flags, tutor profile
--    editing) — these need SELECT/INSERT/UPDATE on the caller's own row only.
create policy "authenticated users read own profile"
  on public.profiles for select
  to authenticated
  using (id = auth.uid());

create policy "authenticated users insert own profile"
  on public.profiles for insert
  to authenticated
  with check (id = auth.uid());

create policy "authenticated users update own profile"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());
