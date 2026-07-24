#!/usr/bin/env node
// scripts/load-test-concurrent-booking.js — SCRUM-41
//
// Proves the double-booking guard actually holds under real concurrency,
// not just in the application's own pre-check. Fires N simultaneous
// POST /api/bookings?action=confirm requests for the SAME tutor + time
// slot and asserts exactly one succeeds — the rest must be rejected,
// backstopped by the `bookings_no_tutor_overlap` exclusion constraint
// (supabase/migrations/20260712162335_add_booking_end_time_and_overlap_constraint.sql)
// for the case where two requests race past the app-level check itself.
//
// WHY THIS NEEDS A REAL DATABASE: the exclusion constraint is enforced by
// Postgres at commit time, under real concurrent transactions. A mocked
// db in the unit test suite can't reproduce that race — this script has
// to run against an actual Postgres-backed deployment.
//
// DO NOT run this against production. Run it against a throwaway Supabase
// branch + its matching Vercel preview deployment, then delete the branch
// when done. Creating a branch costs ~$0.01344/hour (Supabase's per-branch
// compute rate) — trivial, but real money, so this script is not wired
// into `npm test` and must be run manually with an explicit target.
//
// Usage:
//   TARGET_URL=https://<preview-deployment>.vercel.app \
//   TUTOR_NAME="Azeem Omar-Mufti" \
//   node scripts/load-test-concurrent-booking.js
//
// Optional env vars:
//   CONCURRENCY=10        (number of simultaneous booking attempts, default 10)
//   START_TIME=<ISO date> (defaults to 7 days from now at 15:00 UTC)
//   SUBJECT="Maths"
//   LESSON_TYPE=trial
//   STUDENT_LEVEL=GCSE

const TARGET_URL = process.env.TARGET_URL;
if (!TARGET_URL) {
  console.error('Set TARGET_URL to a throwaway preview deployment first — refusing to guess a target.');
  process.exit(1);
}

const CONCURRENCY = Number(process.env.CONCURRENCY || 10);
const TUTOR_NAME = process.env.TUTOR_NAME || 'Azeem Omar-Mufti';
const SUBJECT = process.env.SUBJECT || 'Maths';
const LESSON_TYPE = process.env.LESSON_TYPE || 'trial';
const STUDENT_LEVEL = process.env.STUDENT_LEVEL || 'GCSE';
const START_TIME = process.env.START_TIME || (() => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7);
  d.setUTCHours(15, 0, 0, 0);
  return d.toISOString();
})();

async function attemptBooking(i) {
  const res = await fetch(`${TARGET_URL}/api/bookings?action=confirm`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Distinct per-request IP so SCRUM-20's rate limiter (5 req/15min
      // per IP) doesn't shadow the exclusion-constraint race we're
      // actually testing — this script needs its own synthetic identity
      // per attempt, not real client throttling.
      'X-Forwarded-For': `203.0.113.${i % 254 + 1}`,
    },
    body: JSON.stringify({
      studentName: `Load Test Student ${i}`,
      parentName: `Load Test Parent ${i}`,
      parentEmail: `loadtest-${Date.now()}-${i}@example.com`,
      parentPhone: null,
      tutorName: TUTOR_NAME,
      subject: SUBJECT,
      lessonType: LESSON_TYPE,
      studentLevel: STUDENT_LEVEL,
      startTime: START_TIME,
    }),
  });
  let body;
  try { body = await res.json(); } catch { body = null; }
  return { i, status: res.status, body };
}

async function main() {
  console.log(`Firing ${CONCURRENCY} concurrent booking attempts at ${TARGET_URL}`);
  console.log(`Tutor: ${TUTOR_NAME}  Slot: ${START_TIME}\n`);

  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) => attemptBooking(i))
  );

  const succeeded = results.filter(r => r.status === 200);
  const rejected = results.filter(r => r.status !== 200);

  results
    .sort((a, b) => a.i - b.i)
    .forEach(r => console.log(`  #${r.i}: ${r.status} ${r.body?.error || r.body?.success || ''}`));

  console.log(`\n${succeeded.length} succeeded, ${rejected.length} rejected.`);

  if (succeeded.length === 1) {
    console.log('PASS — exactly one booking won the race, as expected.');
    process.exit(0);
  } else if (succeeded.length === 0) {
    console.log('FAIL — every attempt was rejected (check tutor name / rate limit settings / target URL).');
    process.exit(1);
  } else {
    console.log(`FAIL — ${succeeded.length} bookings were created for the same slot. The overlap guard did not hold under concurrency.`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Script error:', e);
  process.exit(1);
});
