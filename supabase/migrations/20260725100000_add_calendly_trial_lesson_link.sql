-- Separates the public homepage's "Initial Consultation" (15 min,
-- calendly_trial_event_type_uri) from the actual free trial LESSON booked
-- afterwards from the portal (student self-serve, or tutor "Add a lesson"),
-- which should be a real full-length teaching session, not a 15-minute
-- intro call. Both are still free (fee_pence=0, lesson_type='trial') — this
-- only affects which Calendly event type real-time scheduling resolves to.
--
-- Falls back to calendly_event_type_uri (the regular paid-lesson link) when
-- unset, rather than to calendly_trial_event_type_uri (the consultation
-- link) — a real lesson's duration is far closer to a regular lesson's than
-- to a 15-minute call, so this is the safer default until each tutor's
-- actual "Free Trial Lesson" event type is created in Calendly and this
-- column is populated with its URI.
ALTER TABLE public.tutors
  ADD COLUMN IF NOT EXISTS calendly_trial_lesson_event_type_uri text;
