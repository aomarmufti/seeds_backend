-- Reconstructed snapshot of the schema as it existed before migration
-- tracking began (the original tables were created directly against the
-- project, not via tracked migrations). Written from live introspection,
-- not a literal historical record. Safe to run against a fresh database;
-- guarded with IF NOT EXISTS since the live project already has these
-- tables and later migrations in this directory build on them.

create table if not exists public.students (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  parent_name text not null,
  parent_email text not null unique,
  parent_phone text,
  student_name text not null,
  stripe_customer_id text,
  stripe_payment_method_id text
);

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  student_id uuid references public.students(id),
  tutor_name text not null,
  subject text not null,
  lesson_type text not null check (lesson_type = any (array['gcse'::text, 'alevel'::text, 'group'::text, 'trial'::text])),
  start_time timestamptz not null,
  duration_mins integer not null default 55,
  fee_pence integer not null default 0,
  stripe_payment_intent_id text,
  status text not null default 'confirmed' check (status = any (array['confirmed'::text, 'cancelled'::text, 'completed'::text])),
  meet_link text,
  notes text,
  payment_link text,
  stripe_customer_id text
);

create table if not exists public.payouts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  tutor_name text not null,
  amount_pence integer not null,
  status text not null default 'requested' check (status = any (array['requested'::text, 'processing'::text, 'paid'::text])),
  requested_at timestamptz default now(),
  paid_at timestamptz,
  stripe_transfer_id text,
  transfer_status text
);

create table if not exists public.payout_items (
  id uuid primary key default gen_random_uuid(),
  payout_id uuid references public.payouts(id),
  booking_id uuid references public.bookings(id)
);

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  name text not null,
  email text not null,
  subject text not null,
  level text not null,
  goal text,
  availability text[],
  status text not null default 'new' check (status = any (array['new'::text, 'assigned'::text, 'confirmed'::text, 'lost'::text])),
  assigned_tutor text,
  notes text
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id),
  created_at timestamptz default now(),
  role text not null check (role = any (array['student'::text, 'tutor'::text, 'admin'::text, 'pending'::text, 'deactivated'::text])),
  full_name text,
  email text,
  tutor_name text,
  subject text,
  level text,
  assigned_tutor text
);

create table if not exists public.lesson_notes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  booking_id uuid references public.bookings(id),
  student_id uuid references public.students(id),
  tutor_name text not null,
  subject text,
  note text not null
);

create table if not exists public.homework (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  student_id uuid references public.students(id),
  tutor_name text not null,
  subject text,
  title text not null,
  description text,
  due_date date,
  completed boolean default false,
  completed_at timestamptz
);

create table if not exists public.progress (
  id uuid primary key default gen_random_uuid(),
  updated_at timestamptz default now(),
  student_id uuid references public.students(id),
  subject text not null,
  percent integer default 0 check (percent >= 0 and percent <= 100),
  target_grade text,
  current_grade text,
  note text
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  student_id uuid references public.students(id),
  sender_role text not null check (sender_role = any (array['student'::text, 'tutor'::text, 'admin'::text])),
  sender_name text,
  body text not null,
  read boolean default false
);

create table if not exists public.tutor_accounts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  tutor_name text not null unique,
  tutor_email text,
  stripe_account_id text,
  onboarding_complete boolean default false,
  charges_enabled boolean default false,
  payouts_enabled boolean default false
);

alter table public.students enable row level security;
alter table public.bookings enable row level security;
alter table public.payouts enable row level security;
alter table public.payout_items enable row level security;
alter table public.leads enable row level security;
alter table public.profiles enable row level security;
alter table public.lesson_notes enable row level security;
alter table public.homework enable row level security;
alter table public.progress enable row level security;
alter table public.messages enable row level security;
alter table public.tutor_accounts enable row level security;
