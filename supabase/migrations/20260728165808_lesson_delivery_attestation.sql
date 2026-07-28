-- SCRUM-88: bill for lessons that actually happened, not lessons whose
-- start time has passed.
--
-- Before this, billStudentBatch() selected every unbilled booking with
-- start_time <= now(). Nothing anywhere asserted the lesson was delivered,
-- so a no-show, a session the tutor cancelled late, or a lesson that simply
-- didn't happen was billed to the family regardless — the clock passing was
-- the only trigger. bookings.status was no help either: it only ever moved
-- confirmed -> completed as a side effect of the payout cron, so
-- "completed" meant "paid out", not "taught".
--
-- delivery_status is that missing attestation, deliberately kept separate
-- from status so the existing scheduling/payout lifecycle is untouched:
--
--   null            not yet marked  -> NEVER billed (the core fix)
--   'delivered'     lesson taught   -> billable
--   'no_show'       student absent  -> billable (tutor held the time)
--   'late_cancelled'cancelled <18h  -> billable
--   'waived'        not chargeable  -> never billed
--
-- Billable set is exactly ('delivered','no_show','late_cancelled'). A free
-- lesson is billable-by-status but fee_pence = 0, so it still costs nothing.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS delivery_status    text,
  ADD COLUMN IF NOT EXISTS delivered_at       timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_marked_by text,
  ADD COLUMN IF NOT EXISTS delivery_note      text;

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_delivery_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_delivery_status_check
  CHECK (delivery_status IS NULL OR delivery_status IN
    ('delivered', 'no_show', 'late_cancelled', 'waived'));

-- The billing cron's hot path: unbilled + chargeable + billable outcome.
CREATE INDEX IF NOT EXISTS bookings_billable_idx
  ON bookings (student_id, payment_status, delivery_status)
  WHERE fee_pence > 0;

-- Tutor/admin "needs marking" queues.
CREATE INDEX IF NOT EXISTS bookings_awaiting_delivery_idx
  ON bookings (tutor_name, start_time)
  WHERE delivery_status IS NULL AND status = 'confirmed';

-- Backfill: anything already paid or completed plainly did happen, so mark
-- it delivered rather than leaving live history in an unmarked state that
-- the new billing gate would treat as never-billable.
UPDATE bookings
   SET delivery_status = 'delivered',
       delivered_at = COALESCE(delivered_at, end_time),
       delivery_marked_by = COALESCE(delivery_marked_by, 'system:backfill')
 WHERE delivery_status IS NULL
   AND (payment_status IN ('paid', 'invoiced') OR status = 'completed');

-- Past free sessions likewise: they cost nothing, and leaving them unmarked
-- would show them as "awaiting confirmation" forever in the new UI.
UPDATE bookings
   SET delivery_status = 'delivered',
       delivered_at = COALESCE(delivered_at, end_time),
       delivery_marked_by = COALESCE(delivery_marked_by, 'system:backfill')
 WHERE delivery_status IS NULL
   AND fee_pence = 0
   AND status NOT IN ('cancelled', 'requested')
   AND end_time < now();

-- Already-cancelled lessons are not chargeable retrospectively; the 18-hour
-- rule applies only to cancellations made from here on.
UPDATE bookings
   SET delivery_status = 'waived',
       delivery_marked_by = COALESCE(delivery_marked_by, 'system:backfill')
 WHERE delivery_status IS NULL
   AND status = 'cancelled';
