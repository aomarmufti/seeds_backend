-- SCRUM-88 part 2: stop overloading bookings.status as the payout marker.
--
-- The payout path selected status='confirmed' + payment_status='paid' and
-- then PATCHed status='completed' to record "this one has been paid out".
-- That is why 'completed' meant "paid out" rather than "taught", and it
-- leaves two real gaps now that billing is gated on delivery:
--
--   * a late cancellation is chargeable (delivery_status='late_cancelled')
--     but carries status='cancelled', so the family would be billed while
--     the tutor was never paid for the time they held;
--   * marking a lesson delivered wants to set status='completed' — its
--     honest meaning — which under the old scheme would look like an
--     already-paid-out lesson and silently suppress the payout.
--
-- paid_out_at is now the payout marker, so status is free to mean what it
-- says and delivery_status carries the outcome.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS paid_out_at timestamptz;

-- Anything already completed AND paid was paid out under the old scheme.
-- Backfilling is essential: without it the new query would treat every
-- historical payout as outstanding and pay tutors a second time.
UPDATE bookings
   SET paid_out_at = COALESCE(paid_out_at, end_time, now())
 WHERE paid_out_at IS NULL
   AND status = 'completed'
   AND payment_status = 'paid'
   AND fee_pence > 0;

-- Payout hot path: billable outcome, family paid, not yet paid out.
CREATE INDEX IF NOT EXISTS bookings_awaiting_payout_idx
  ON bookings (tutor_name, delivery_status, payment_status)
  WHERE paid_out_at IS NULL AND fee_pence > 0;
