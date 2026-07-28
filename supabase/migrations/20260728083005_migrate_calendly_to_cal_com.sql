-- Migrate real-time scheduling from Calendly to Cal.com.
--
-- Root cause of the outage this fixes: Calendly's free plan only allows
-- ONE active event type across the whole connected account (already hit
-- once — SCRUM-67 — and hit again when that trial/plan lapsed, silently
-- deactivating the one link every tutor was sharing). Cal.com's free
-- individual plan allows unlimited event types, and unlike Calendly this
-- account model is genuinely per-tutor: every tutor gets their own Cal.com
-- account rather than funneling through one shared one, so bookings
-- actually reflect each tutor's own calendar/availability for the first
-- time.
--
-- Schema choice: three full public booking URLs per tutor (one per lesson
-- context) rather than a username + assumed slug convention — different
-- tutors' own Cal.com accounts won't necessarily use the same event-type
-- slugs (Azeem's happen to be /lesson, /15min, /60min), so storing the
-- complete URL per context is the only assumption-free option.

ALTER TABLE public.tutors
  ADD COLUMN IF NOT EXISTS cal_lesson_link text,
  ADD COLUMN IF NOT EXISTS cal_consultation_link text,
  ADD COLUMN IF NOT EXISTS cal_trial_link text;

-- calendly_trial_event_type_uri and calendly_trial_lesson_event_type_uri
-- were already dead — SCRUM-67 consolidated every booking context onto
-- calendly_event_type_uri alone and nothing in the codebase read the other
-- two afterward (confirmed by reading every caller before writing this).
ALTER TABLE public.tutors
  DROP COLUMN IF EXISTS calendly_event_type_uri,
  DROP COLUMN IF EXISTS calendly_trial_event_type_uri,
  DROP COLUMN IF EXISTS calendly_trial_lesson_event_type_uri;

-- profiles.calendly_event_type_uri / calendly_trial_event_type_uri: a
-- second, separate copy of the same idea on the wrong table, from before
-- the canonical tutors table existed. api/leads.js's admin "assign tutor"
-- flow was still reading profiles.calendly_event_type_uri instead of the
-- tutors-table column every other booking path already used — meaning
-- that flow was silently broken (found while migrating this; fixed in the
-- application code alongside this migration, reading from tutors like
-- everything else).
ALTER TABLE public.profiles
  DROP COLUMN IF EXISTS calendly_event_type_uri,
  DROP COLUMN IF EXISTS calendly_trial_event_type_uri;

-- Seed Azeem Omar-Mufti's real Cal.com links (confirmed with the account
-- owner) — the default tutor when no specific preference is given.
-- Abdul-Moez and Suleiman need their own individual Cal.com accounts set
-- up before their rows can be populated the same way; until then they
-- fall back to the manual propose-slots flow, same as any tutor without
-- real-time scheduling configured previously.
UPDATE public.tutors
SET
  cal_lesson_link = 'https://cal.eu/azeem-mufti-h4oqbq/lesson',
  cal_consultation_link = 'https://cal.eu/azeem-mufti-h4oqbq/15min',
  cal_trial_link = 'https://cal.eu/azeem-mufti-h4oqbq/60min'
WHERE name = 'Azeem Omar-Mufti';

-- Replaces calendly_webhook_events (Calendly's invitee-uri+event-name
-- dedup key doesn't apply to Cal.com's payload shape, which has its own
-- booking uid) — same idempotency-dedup purpose as its Stripe counterpart.
DROP TABLE IF EXISTS public.calendly_webhook_events;

CREATE TABLE IF NOT EXISTS public.cal_webhook_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cal_webhook_events ENABLE ROW LEVEL SECURITY;
