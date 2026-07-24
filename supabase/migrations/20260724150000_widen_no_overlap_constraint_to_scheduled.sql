-- Widen bookings_no_tutor_overlap to also cover 'scheduled' bookings.
--
-- Paid lessons booked through the student/tutor portals now start as
-- 'scheduled' (awaiting payment) rather than 'confirmed' immediately —
-- see the api/lifecycle.js change in this same PR. A 'scheduled' booking
-- still genuinely occupies the tutor's slot while payment is pending
-- (which can take anywhere from seconds to days, for the "no saved card,
-- pay via emailed link" path), so the exclusion constraint needs to guard
-- it too, or two different families could each land a 'scheduled'
-- booking for the same overlapping slot during that window.
--
-- 'cancelled' bookings should never block a new booking. Any other
-- status (confirmed, scheduled, completed, payment_failed) represents a
-- slot that either is or was actively held, so excluding everything
-- except 'cancelled' is the correct, simplest condition — narrower than
-- "just confirmed", but not so narrow it reopens the original bug this
-- constraint exists to prevent.
ALTER TABLE public.bookings
  DROP CONSTRAINT bookings_no_tutor_overlap;

ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_no_tutor_overlap
  EXCLUDE USING gist (
    tutor_name WITH =,
    tstzrange(start_time, end_time) WITH &&
  ) WHERE (status <> 'cancelled');
