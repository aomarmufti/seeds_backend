-- SCRUM-25/SCRUM-24 (descoped, per product decision): rather than real file
-- storage (a storage bucket, upload UI, per-file access control — real
-- ongoing cost and complexity for what's fundamentally "tutor shares a
-- link"), a tutor pastes a link they already use (Google Drive, OneDrive,
-- Zoom recording, etc.). One table covers both tickets: `type='resource'`
-- is the tutor portal's Resources panel (materials shared with a specific
-- student, or student_id null = all of this tutor's students), and
-- `type='recording'` is the student portal's Group Sessions recordings tab.
CREATE TABLE public.resources (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  tutor_name text not null,
  student_id uuid references public.students(id),
  type text not null default 'resource' check (type in ('resource', 'recording')),
  subject text,
  title text not null,
  url text not null
);

CREATE INDEX resources_student_id_idx ON public.resources(student_id);
CREATE INDEX resources_tutor_name_idx ON public.resources(tutor_name);

ALTER TABLE public.resources ENABLE ROW LEVEL SECURITY;
-- No policies added — matches the rate_limits pattern (SCRUM-20): RLS with
-- zero policies denies all anon/authenticated access by default, so only
-- the backend's service-role key (via the ownership checks in api/lifecycle.js)
-- can read or write this table.
