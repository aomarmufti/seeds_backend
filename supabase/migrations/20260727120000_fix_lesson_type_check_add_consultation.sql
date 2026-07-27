-- SCRUM-58 follow-up: bookings_lesson_type_check never learned about the
-- new 'consultation' lesson_type introduced alongside it (only the
-- companion bookings_one_consultation_per_student unique index was added).
-- Every api/bookings.js action=confirm insert has been failing at the DB
-- layer with a check-constraint violation (surfaced to callers as a 500)
-- since that change shipped, since it unconditionally sets
-- lesson_type: 'consultation'.
ALTER TABLE public.bookings DROP CONSTRAINT bookings_lesson_type_check;
ALTER TABLE public.bookings ADD CONSTRAINT bookings_lesson_type_check
  CHECK (lesson_type = ANY (ARRAY['gcse'::text, 'alevel'::text, 'group'::text, 'trial'::text, 'consultation'::text]));
