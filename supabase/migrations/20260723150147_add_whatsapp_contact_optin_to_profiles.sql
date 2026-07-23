-- SCRUM-55: parent/tutor contact opt-in (email always visible via existing
-- profiles/students email columns; WhatsApp is opt-in only).
ALTER TABLE public.profiles ADD COLUMN whatsapp_number text;
ALTER TABLE public.profiles ADD COLUMN whatsapp_opted_in boolean NOT NULL DEFAULT false;
