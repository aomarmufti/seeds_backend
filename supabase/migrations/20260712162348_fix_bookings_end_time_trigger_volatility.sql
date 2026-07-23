CREATE OR REPLACE FUNCTION public.bookings_set_end_time()
RETURNS trigger AS $$
BEGIN
  NEW.end_time := NEW.start_time + make_interval(mins => NEW.duration_mins);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = '';
