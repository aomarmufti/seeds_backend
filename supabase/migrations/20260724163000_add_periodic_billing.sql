-- Periodic ("batch") billing: a family is charged once per billing cycle
-- (weekly or monthly, their own choice) for every lesson that has actually
-- happened since their last charge, instead of being charged (or emailed a
-- payment link) the moment each lesson is booked. Replaces the previous
-- book-now-pay-now model entirely for non-trial lessons.
--
-- bookings.status keeps meaning the LESSON's own lifecycle (scheduled →
-- confirmed → completed, or cancelled) — under this model a booking is
-- confirmed the moment it's made, regardless of lesson type, since payment
-- no longer gates the booking itself. Whether it's actually been PAID FOR
-- is now tracked entirely separately via payment_status, so the two
-- questions ("is this lesson happening" vs "has this lesson been paid
-- for") can never be conflated again the way status alone was overloaded
-- to mean both earlier in this project's history.

ALTER TABLE public.students
  ADD COLUMN IF NOT EXISTS billing_cycle text NOT NULL DEFAULT 'weekly'
    CHECK (billing_cycle IN ('weekly', 'monthly'));

CREATE TABLE IF NOT EXISTS public.billing_batches (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  student_id uuid references public.students(id) not null,
  cycle text not null check (cycle in ('weekly', 'monthly')),
  period_start timestamptz not null,
  period_end timestamptz not null,
  total_pence integer not null,
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'payment_link_sent', 'failed')),
  stripe_payment_intent_id text,
  stripe_checkout_session_id text,
  payment_link text,
  paid_at timestamptz
);

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS billing_batch_id uuid references public.billing_batches(id);

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'unbilled'
    CHECK (payment_status IN ('unbilled', 'invoiced', 'paid', 'failed', 'free'));

-- Backfill existing rows from the data we already have, best-effort —
-- this is a one-time reconciliation for bookings created before this
-- migration, not something new bookings will need going forward (new
-- bookings get their payment_status set explicitly by the app).
UPDATE public.bookings SET payment_status = 'free' WHERE fee_pence = 0;
UPDATE public.bookings SET payment_status = 'paid'
  WHERE fee_pence > 0 AND payment_status = 'unbilled'
    AND (stripe_payment_intent_id IS NOT NULL);
UPDATE public.bookings SET payment_status = 'failed'
  WHERE status = 'payment_failed' AND payment_status = 'unbilled';

-- No RLS policies needed on billing_batches — this backend only ever
-- accesses the database with the service key, which bypasses RLS by
-- design; ownership/authorization checks all live in the API layer
-- instead, matching every other table in this project.
