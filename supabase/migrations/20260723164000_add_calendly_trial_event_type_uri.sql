-- SCRUM-55/52 follow-up: distinguish the "initial consultation" (new
-- student / free trial) Calendly event type from the regular paid-lesson
-- one. Same tutor typically uses two different Calendly event types for
-- these — a single calendly_event_type_uri column can't represent both.
ALTER TABLE public.tutors ADD COLUMN IF NOT EXISTS calendly_trial_event_type_uri text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS calendly_trial_event_type_uri text;
