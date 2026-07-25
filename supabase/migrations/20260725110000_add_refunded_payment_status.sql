-- SCRUM-56 follow-up: cancel-booking/refund-booking/bulk-cancel previously
-- had no way to record that a paid booking was refunded — the CHECK
-- constraint only allowed unbilled/invoiced/paid/failed/free, so a
-- successful refund left payment_status stuck at 'paid' forever, and
-- revenue dashboards kept counting refunded money as real revenue.
alter table bookings drop constraint bookings_payment_status_check;
alter table bookings add constraint bookings_payment_status_check
  check (payment_status in ('unbilled', 'invoiced', 'paid', 'failed', 'free', 'refunded'));
