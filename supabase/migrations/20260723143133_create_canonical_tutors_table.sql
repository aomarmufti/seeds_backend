-- SCRUM-28: canonical tutors table with FKs, replacing free-text tutor_name
-- duplicated (and un-enforced) across bookings, payouts, tutor_accounts, and
-- 4 separately hardcoded name->meet-link maps in application code.

CREATE TABLE public.tutors (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  email text,
  subjects text,
  meet_link text,
  stripe_account_id text,
  onboarding_complete boolean not null default false,
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  calendly_event_type_uri text,
  created_at timestamptz not null default now()
);

-- Seed from every place a tutor name currently shows up, so all 3 real
-- tutors get a canonical row even though only one of them (Azeem) has a
-- profiles/tutor_accounts row today - Suleiman and Abdul-Moez exist only as
-- free-text strings right now, which is exactly the bug this ticket is for.
INSERT INTO public.tutors (name)
SELECT DISTINCT tutor_name FROM (
  SELECT tutor_name FROM public.bookings
  UNION SELECT tutor_name FROM public.payouts
  UNION SELECT tutor_name FROM public.tutor_accounts
  UNION SELECT tutor_name FROM public.profiles WHERE tutor_name IS NOT NULL
) all_names
WHERE tutor_name IS NOT NULL
ON CONFLICT (name) DO NOTHING;

-- Backfill known fields from existing tables for whichever tutor(s) already
-- have them (currently just Azeem, via profiles + tutor_accounts).
UPDATE public.tutors t SET
  email = p.email,
  calendly_event_type_uri = p.calendly_event_type_uri
FROM public.profiles p
WHERE p.tutor_name = t.name AND p.role = 'tutor';

UPDATE public.tutors t SET
  stripe_account_id = ta.stripe_account_id,
  onboarding_complete = ta.onboarding_complete,
  charges_enabled = ta.charges_enabled,
  payouts_enabled = ta.payouts_enabled,
  email = COALESCE(t.email, ta.tutor_email)
FROM public.tutor_accounts ta
WHERE ta.tutor_name = t.name;

-- Additive FK columns — nullable so nothing breaks; a BEFORE INSERT trigger
-- below keeps them populated automatically from tutor_name for existing
-- application code that doesn't know about tutor_id yet.
ALTER TABLE public.bookings ADD COLUMN tutor_id uuid REFERENCES public.tutors(id);
ALTER TABLE public.payouts ADD COLUMN tutor_id uuid REFERENCES public.tutors(id);
ALTER TABLE public.tutor_accounts ADD COLUMN tutor_id uuid REFERENCES public.tutors(id);

UPDATE public.bookings b SET tutor_id = t.id FROM public.tutors t WHERE b.tutor_name = t.name;
UPDATE public.payouts p SET tutor_id = t.id FROM public.tutors t WHERE p.tutor_name = t.name;
UPDATE public.tutor_accounts ta SET tutor_id = t.id FROM public.tutors t WHERE ta.tutor_name = t.name;

CREATE INDEX bookings_tutor_id_idx ON public.bookings(tutor_id);
CREATE INDEX payouts_tutor_id_idx ON public.payouts(tutor_id);

-- Auto-populate tutor_id from tutor_name on insert, so every existing
-- api/*.js call site that only sets tutor_name keeps working unchanged.
CREATE OR REPLACE FUNCTION public.set_tutor_id_from_name()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF NEW.tutor_id IS NULL AND NEW.tutor_name IS NOT NULL THEN
    SELECT id INTO NEW.tutor_id FROM public.tutors WHERE name = NEW.tutor_name;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER bookings_set_tutor_id BEFORE INSERT ON public.bookings
FOR EACH ROW EXECUTE FUNCTION public.set_tutor_id_from_name();

CREATE TRIGGER payouts_set_tutor_id BEFORE INSERT ON public.payouts
FOR EACH ROW EXECUTE FUNCTION public.set_tutor_id_from_name();

-- This is the actual "rename in one place updates everywhere" guarantee:
-- updating tutors.name cascades the new name into every table that still
-- carries a denormalized tutor_name copy, without requiring every read
-- call site across the app to be rewritten to join against tutors.
CREATE OR REPLACE FUNCTION public.propagate_tutor_rename()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE public.bookings SET tutor_name = NEW.name WHERE tutor_id = NEW.id;
    UPDATE public.payouts SET tutor_name = NEW.name WHERE tutor_id = NEW.id;
    UPDATE public.tutor_accounts SET tutor_name = NEW.name WHERE tutor_id = NEW.id;
    UPDATE public.profiles SET tutor_name = NEW.name WHERE tutor_name = OLD.name;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER tutors_propagate_rename AFTER UPDATE ON public.tutors
FOR EACH ROW EXECUTE FUNCTION public.propagate_tutor_rename();

-- Lock down both trigger functions per the SCRUM-47 pattern: pin
-- search_path, and these are trigger-only, never meant as public RPCs.
REVOKE EXECUTE ON FUNCTION public.set_tutor_id_from_name() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.propagate_tutor_rename() FROM PUBLIC;

ALTER TABLE public.tutors ENABLE ROW LEVEL SECURITY;
