ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS calendly_event_type_uri text;

CREATE TABLE IF NOT EXISTS public.calendly_webhook_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.calendly_webhook_events ENABLE ROW LEVEL SECURITY;
