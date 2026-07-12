ALTER TABLE public.bookings DROP CONSTRAINT bookings_status_check;
ALTER TABLE public.bookings ADD CONSTRAINT bookings_status_check
  CHECK (status = ANY (ARRAY[
    'requested'::text, 'tutor_assigned'::text, 'scheduled'::text,
    'confirmed'::text, 'payment_failed'::text, 'cancelled'::text, 'completed'::text
  ]));

ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS calendly_event_uri text;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS calendly_invitee_uri text;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS stripe_checkout_session_id text;
