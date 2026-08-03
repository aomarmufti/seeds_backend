-- SCRUM-XX50: Add tutor_id to profiles table
--
-- Tutors are currently identified by name string (profiles.tutor_name),
-- which causes authorization failures and makes renaming dangerous.
-- Add tutor_id as a FK to tutors(id), and populate it from existing
-- tutor_name values.

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS tutor_id uuid REFERENCES public.tutors(id) ON DELETE SET NULL;

-- Backfill tutor_id from tutor_name for existing tutor profiles
UPDATE public.profiles p
   SET tutor_id = t.id
  FROM public.tutors t
 WHERE p.role = 'tutor'
   AND p.tutor_name = t.name
   AND p.tutor_id IS NULL;

-- Create index for fast tutor lookups
CREATE INDEX IF NOT EXISTS profiles_tutor_id_idx ON public.profiles(tutor_id) WHERE tutor_id IS NOT NULL;
