-- Backfill booking.enrolment_id for existing bookings
-- Links each booking to the student's enrolment matching its subject (or primary enrolment if no match)

-- For bookings where we can match by student + subject, link to that enrolment
UPDATE public.bookings b
   SET enrolment_id = e.id
  FROM public.enrolments e
 WHERE b.student_id = e.student_id
   AND b.subject IS NOT NULL
   AND e.subject = b.subject
   AND b.enrolment_id IS NULL
   AND e.status IN ('active', 'pending');

-- For remaining bookings without an enrolment link, assign to the student's primary active enrolment
UPDATE public.bookings b
   SET enrolment_id = e.id
  FROM (
    SELECT DISTINCT ON (student_id) id, student_id
      FROM public.enrolments
     WHERE status = 'active'
     ORDER BY student_id, created_at ASC
  ) e
 WHERE b.student_id = e.student_id
   AND b.enrolment_id IS NULL;

-- Create index on booking + enrolment (useful for queries filtering by both)
CREATE INDEX IF NOT EXISTS bookings_student_enrolment_idx ON public.bookings(student_id, enrolment_id);
