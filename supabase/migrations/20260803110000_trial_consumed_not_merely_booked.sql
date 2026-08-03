-- SCRUM-94: a no-showed free trial permanently burned the family's one trial.
--
-- The rule was enforced by this index:
--
--   CREATE UNIQUE INDEX bookings_one_trial_per_student
--     ON public.bookings (student_id)
--     WHERE lesson_type = 'trial' AND status <> 'cancelled';
--
-- Recording a student no-show sets status = 'completed' (with
-- delivery_status = 'no_show'). "Completed" is not "cancelled", so the row
-- kept its slot in the index and the next trial insert was refused. A family
-- lost their one free trial to a lesson they never received.
--
-- The index conflated "a trial row exists" with "the trial was used up".
-- Those are different questions: a trial is consumed when the student
-- actually got teaching — delivered, or cut short partway. A no-show, a
-- cancellation by either side, or a late cancellation all leave the family
-- having received nothing, and none of them should burn the trial.
--
-- Enforcement is split in two, because one index cannot express both halves:
--
--   * one CONSUMED trial per student — the rule itself
--   * one OPEN trial per student — so a family cannot hold two trial
--     bookings waiting to happen at once, which the old index did do
--     (via status <> 'cancelled') and which is worth keeping
--
-- What neither index can express is "you already consumed a trial, so you may
-- not book another one" — that needs to look at other rows at insert time, so
-- it lives in lib/trialEligibility.js and runs before the insert. These
-- indexes remain the backstop underneath it.

DROP INDEX IF EXISTS public.bookings_one_trial_per_student;

-- The rule: teaching actually received, once.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_consumed_trial_per_student
  ON public.bookings (student_id)
  WHERE lesson_type = 'trial'
    AND delivery_status IN ('delivered', 'partial');

-- And one trial in flight at a time. A trial that has not been assessed yet
-- has no delivery_status, so this catches exactly the not-yet-answered ones.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_open_trial_per_student
  ON public.bookings (student_id)
  WHERE lesson_type = 'trial'
    AND status <> 'cancelled'
    AND delivery_status IS NULL;

-- Existing rows migrate cleanly: any student who previously had one trial row
-- has at most one that is delivered/partial and at most one unassessed, so
-- neither new index can be violated by data the old one already permitted.
