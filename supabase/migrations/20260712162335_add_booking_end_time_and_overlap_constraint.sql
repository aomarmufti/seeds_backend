ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS end_time timestamptz;

UPDATE public.bookings SET end_time = start_time + make_interval(mins => duration_mins) WHERE end_time IS NULL;

ALTER TABLE public.bookings ALTER COLUMN end_time SET NOT NULL;

CREATE OR REPLACE FUNCTION public.bookings_set_end_time()
RETURNS trigger AS $$
BEGIN
  NEW.end_time := NEW.start_time + make_interval(mins => NEW.duration_mins);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql IMMUTABLE SET search_path = '';

CREATE TRIGGER bookings_set_end_time_trigger
  BEFORE INSERT OR UPDATE OF start_time, duration_mins ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.bookings_set_end_time();

ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_no_tutor_overlap
  EXCLUDE USING gist (
    tutor_name WITH =,
    tstzrange(start_time, end_time) WITH &&
  ) WHERE (status = 'confirmed');
