CREATE UNIQUE INDEX bookings_one_trial_per_student
  ON public.bookings (student_id)
  WHERE lesson_type = 'trial' AND status <> 'cancelled';
