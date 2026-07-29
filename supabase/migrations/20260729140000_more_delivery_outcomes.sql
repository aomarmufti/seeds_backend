-- The outcome set was too narrow for what actually happens in a week of
-- teaching. A tutor could only say "taught" or "no-show", so every other
-- real situation — the two of you agreeing to move it, the tutor being the
-- one who couldn't make it, a lesson cut short — had to be forced into one
-- of those two, and both of them bill the family in full.
--
-- Adds the outcomes that don't bill, so a tutor never has to choose between
-- charging a family for a lesson that didn't happen and leaving the booking
-- unanswered forever.
--
--   BILLABLE (family charged, tutor paid)
--     delivered        taught as planned
--     no_show          student didn't attend, tutor held the slot
--     late_cancelled   family cancelled inside 18h, tutor held the slot
--     partial          started but cut short by the student's side
--
--   NOT BILLABLE
--     cancelled_mutual both sides agreed to cancel/move it
--     tutor_cancelled  tutor withdrew, was absent, or couldn't deliver it
--     waived           goodwill / admin discretion
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_delivery_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_delivery_status_check
  CHECK (delivery_status IS NULL OR delivery_status IN
    ('delivered', 'no_show', 'late_cancelled', 'partial',
     'cancelled_mutual', 'tutor_cancelled', 'waived'));
