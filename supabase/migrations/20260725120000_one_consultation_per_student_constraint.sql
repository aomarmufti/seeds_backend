-- SCRUM-58: the public wizard's free Initial Consultation now has its own
-- lesson_type ('consultation') separate from the portal-booked trial
-- lesson ('trial'), so bookings_one_trial_per_student no longer limits how
-- many free consultations a family can book. Mirror it for consultations.
CREATE UNIQUE INDEX bookings_one_consultation_per_student
  ON public.bookings (student_id)
  WHERE lesson_type = 'consultation' AND status <> 'cancelled';
