ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS availability text[] DEFAULT '{}'::text[];
