-- SCRUM-XX49: Enrolments table for multi-subject, multi-tutor support
--
-- An enrolment is: this student, studying this subject, at this level, with this tutor, at this rate, in this state.
-- Replaces the single subject + assigned_tutor pair on the student record with proper many-to-many relationships.
--
-- Migration strategy:
-- 1. Create enrolments table
-- 2. Create index on student_id for fast lookups
-- 3. Migrate existing students: one enrolment per student from their current subject + assigned_tutor
-- 4. Keep profiles.subject and profiles.assigned_tutor as read-only mirrors until all screens move to enrolments
-- 5. Add enrolment_id to bookings (without NOT NULL yet, to allow gradual migration)

CREATE TABLE public.enrolments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),

  student_id uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  subject text NOT NULL,
  level text NOT NULL CHECK (level = any (array['GCSE'::text, 'A-Level'::text, 'KS3'::text])),

  tutor_id uuid REFERENCES public.tutors(id) ON DELETE SET NULL,

  status text NOT NULL DEFAULT 'pending' CHECK (status = any (array['pending'::text, 'active'::text, 'paused'::text, 'ended'::text])),
  rate_pence integer NOT NULL,

  started_at timestamptz DEFAULT now(),
  ended_at timestamptz
);

-- Index for fast lookups by student
CREATE INDEX IF NOT EXISTS enrolments_student_id_idx ON public.enrolments(student_id);

-- Index for fast lookups by tutor
CREATE INDEX IF NOT EXISTS enrolments_tutor_id_idx ON public.enrolments(tutor_id);

-- Index for active enrolments (status = 'active')
CREATE INDEX IF NOT EXISTS enrolments_active_idx ON public.enrolments(student_id, status) WHERE status = 'active'::text;

-- Backfill existing enrolments from students + profiles + tutors
-- Each student gets one enrolment from their current subject and assigned_tutor.
-- Subject comes from profiles if available, otherwise from the lead, otherwise defaults to Mathematics.
-- Level comes from profiles if available, otherwise from the lead, otherwise defaults to GCSE.
-- Status is 'active' if the tutor has been assigned and the family has an account, 'pending' otherwise.
INSERT INTO public.enrolments (student_id, subject, level, tutor_id, status, rate_pence, started_at)
SELECT
  s.id,
  COALESCE(p.subject, l.subject, 'Mathematics') as subject,
  COALESCE(p.level, l.level, 'GCSE') as level,
  t.id as tutor_id,
  CASE WHEN s.assigned_tutor IS NOT NULL AND p.id IS NOT NULL THEN 'active' ELSE 'pending' END as status,
  CASE
    WHEN COALESCE(p.level, l.level, 'GCSE') = 'A-Level' THEN 4500
    ELSE 4000
  END as rate_pence,
  now() as started_at
FROM public.students s
LEFT JOIN public.profiles p ON lower(s.parent_email) = lower(p.email)
LEFT JOIN public.leads l ON s.lead_id = l.id
LEFT JOIN public.tutors t ON s.assigned_tutor = t.name
WHERE s.assigned_tutor IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.enrolments e
    WHERE e.student_id = s.id
  );

-- Add enrolment_id to bookings (nullable for now, to allow gradual migration)
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS enrolment_id uuid REFERENCES public.enrolments(id) ON DELETE SET NULL;

-- Create index on enrolment_id for fast lookups
CREATE INDEX IF NOT EXISTS bookings_enrolment_id_idx ON public.bookings(enrolment_id);

-- Backfill existing bookings with their enrolment_id
UPDATE public.bookings b
   SET enrolment_id = e.id
  FROM public.enrolments e
 WHERE b.student_id = e.student_id
   AND e.status = 'active'
   AND b.enrolment_id IS NULL;

-- Enable RLS on enrolments. Policies will be added when the /api/enrolments
-- endpoints are built. For now, the backend uses the service role which
-- bypasses RLS entirely, so this table is safe to leave with no policies.
ALTER TABLE public.enrolments ENABLE ROW LEVEL SECURITY;
