-- A student had no way to be linked to a tutor except by having a booking
-- with them. Assigning a lead to a tutor wrote only to leads.assigned_tutor,
-- so the family existed nowhere the rest of the product looks: admin's
-- Students page reads the students table, the tutor portal's My Students
-- derives its roster from bookings.tutor_name, and neither could see a
-- student who had been assigned but hadn't booked yet.
--
-- profiles.assigned_tutor already existed but is only set for accounts that
-- have signed up — a lead assigned before the family ever creates a login has
-- no profiles row to carry it. students is the table every view actually
-- reads, so the link belongs here.
ALTER TABLE students ADD COLUMN IF NOT EXISTS assigned_tutor text;

-- Also record the originating lead so an assigned-but-not-yet-booked student
-- can be traced back, and admin can tell a real signup from a lead-created
-- placeholder.
ALTER TABLE students ADD COLUMN IF NOT EXISTS lead_id uuid;

-- Backfill 1: accounts that already carry an assignment on their profile.
UPDATE students s
   SET assigned_tutor = p.assigned_tutor
  FROM profiles p
 WHERE s.assigned_tutor IS NULL
   AND p.assigned_tutor IS NOT NULL
   AND lower(p.email) = lower(s.parent_email);

-- Backfill 2: students whose only tutor link is the bookings they already
-- have. Picks their most recent tutor, which is the one the portals were
-- effectively already showing.
UPDATE students s
   SET assigned_tutor = b.tutor_name
  FROM (
    SELECT DISTINCT ON (student_id) student_id, tutor_name
      FROM bookings
     WHERE tutor_name IS NOT NULL AND status <> 'cancelled'
     ORDER BY student_id, start_time DESC
  ) b
 WHERE s.assigned_tutor IS NULL
   AND b.student_id = s.id;

CREATE INDEX IF NOT EXISTS students_assigned_tutor_idx ON students (assigned_tutor);
