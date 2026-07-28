-- Follow-up to 20260728083005_migrate_calendly_to_cal_com.sql: bookings had
-- its own pair of Calendly-specific columns (added separately, in
-- 20260712170000_extend_booking_status_for_payments_sprint.sql) not caught
-- in the first pass. Cal.com's booking model is simpler than Calendly's —
-- one booking has a single `uid`, no separate invitee identifier — so this
-- is one column, not two.
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS cal_booking_uid text;
ALTER TABLE public.bookings DROP COLUMN IF EXISTS calendly_event_uri;
ALTER TABLE public.bookings DROP COLUMN IF EXISTS calendly_invitee_uri;
