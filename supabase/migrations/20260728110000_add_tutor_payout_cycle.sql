-- SCRUM-76: payouts are automatic (api/lifecycle?resource=auto-payout),
-- but always ran weekly for every onboarded tutor. Admin now sets each
-- tutor's own cadence, mirroring students.billing_cycle.
ALTER TABLE public.tutor_accounts
  ADD COLUMN IF NOT EXISTS payout_cycle text NOT NULL DEFAULT 'weekly'
  CHECK (payout_cycle IN ('weekly', 'monthly'));
