// SCRUM-41: concurrency test for the booking-conflict path.
//
// This cannot be a true multi-connection load test against a real
// Postgres instance from this environment (no staging environment exists
// yet — SCRUM-40 — and this sandbox has no direct DB connection, only the
// Supabase REST API via MCP). What it DOES verify, honestly: the
// application code's own race-safety property. api/bookings.js's own
// comment says it plainly — the pre-check query (dbGet for a conflicting
// booking) is a courtesy for the common case, and the DB's
// bookings_no_tutor_overlap exclusion constraint is "the backstop for
// the race this handler's own pre-check can't fully close." This test
// simulates exactly that race — N requests for the same tutor+slot all
// pass their pre-check simultaneously (because none of the others have
// committed yet) — and proves the handler still lets only one booking
// through instead of trusting the pre-check as sufficient.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWithMocks, makeRes } = require('./helpers/loadWithMocks');

function overlaps(aStart, aDurationMins, bStart, bDurationMins) {
  const aStartMs = new Date(aStart).getTime();
  const aEndMs = aStartMs + aDurationMins * 60000;
  const bStartMs = new Date(bStart).getTime();
  const bEndMs = bStartMs + bDurationMins * 60000;
  return aStartMs < bEndMs && bStartMs < aEndMs;
}

// concurrency: how many pre-checks to let pile up before releasing them
// all at once — must match the number of requests fired in the test, so
// every one of them reads the same "nothing committed yet" snapshot.
function makeRacingDb(concurrency) {
  const committed = [];
  let pendingCount = 0;
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });

  return {
    dbGet: async (path) => {
      if (!path.startsWith('/bookings?tutor_name=')) return [];
      pendingCount++;
      if (pendingCount === concurrency) releaseGate();
      await gate;
      return []; // every caller sees zero conflicts — nothing has committed yet
    },
    dbPost: async (path, body) => {
      if (path !== '/bookings') return { id: 'other' };
      // The DB exclusion constraint is what actually serializes commits —
      // only the first insert for a given tutor+overlapping-window wins.
      const conflict = committed.some((b) =>
        b.tutor_name === body.tutor_name && b.status !== 'cancelled' &&
        overlaps(body.start_time, body.duration_mins, b.start_time, b.duration_mins)
      );
      if (conflict) {
        throw new Error('conflicting key value violates exclusion constraint "bookings_no_tutor_overlap"');
      }
      committed.push(body);
      return { id: `booking-${committed.length}`, ...body };
    },
    dbPatch: async () => ({}),
  };
}

test('N concurrent bookings for the same tutor+slot: exactly one succeeds, the rest get a 409 conflict (not a double-booking)', async () => {
  const CONCURRENT_REQUESTS = 5;
  const handler = loadWithMocks('api/bookings.js', { db: makeRacingDb(CONCURRENT_REQUESTS) });

  const startTime = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const requests = Array.from({ length: CONCURRENT_REQUESTS }, (_, i) => {
    const res = makeRes();
    return handler({
      query: { action: 'confirm' },
      body: {
        studentName: `Student ${i}`, parentName: `Parent ${i}`, parentEmail: `parent${i}@example.com`,
        tutorName: 'Azeem Omar-Mufti', subject: 'Maths', lessonType: 'consultation', studentLevel: 'gcse',
        startTime,
      },
    }, res).then(() => res);
  });

  const results = await Promise.all(requests);
  const succeeded = results.filter((r) => r.statusCode === 200);
  const conflicted = results.filter((r) => r.statusCode === 409 && r.body.conflict === true);

  assert.equal(succeeded.length, 1, 'exactly one concurrent request for the same slot must win — the DB constraint must be the real arbiter, not the app-level pre-check');
  assert.equal(conflicted.length, CONCURRENT_REQUESTS - 1, 'every loser must get a friendly 409, not a 500 or a silent double-booking');
});

test('N concurrent bookings for DIFFERENT tutors at the same time all succeed independently', async () => {
  const tutors = ['Azeem Omar-Mufti', 'Suleiman', 'Abdul-Moez'];
  const handler = loadWithMocks('api/bookings.js', { db: makeRacingDb(tutors.length) });

  const startTime = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const requests = tutors.map((tutorName, i) => {
    const res = makeRes();
    return handler({
      query: { action: 'confirm' },
      body: {
        studentName: `Student ${i}`, parentName: `Parent ${i}`, parentEmail: `parent${i}@example.com`,
        tutorName, subject: 'Maths', lessonType: 'consultation', studentLevel: 'gcse',
        startTime,
      },
    }, res).then(() => res);
  });

  const results = await Promise.all(requests);
  assert.ok(results.every((r) => r.statusCode === 200), 'different tutors at the same time must never conflict with each other');
});

test('N concurrent bookings for overlapping (not identical) windows for the same tutor: only one succeeds', async () => {
  const CONCURRENT_REQUESTS = 4;
  const handler = loadWithMocks('api/bookings.js', {
    db: makeRacingDb(CONCURRENT_REQUESTS),
    pricing: { resolvePrice: () => ({ duration: 15, amount: 0 }) }, // real consultation length
  });

  // 15-minute slots, staggered by 3 min each (4 requests span 9 min total,
  // inside the 15-min duration) so every pair genuinely overlaps — not
  // just adjacent-but-touching — without all four being byte-identical.
  const base = Date.now() + 24 * 3600 * 1000;
  const requests = Array.from({ length: CONCURRENT_REQUESTS }, (_, i) => {
    const res = makeRes();
    return handler({
      query: { action: 'confirm' },
      body: {
        studentName: `Student ${i}`, parentName: `Parent ${i}`, parentEmail: `parent${i}@example.com`,
        tutorName: 'Azeem Omar-Mufti', subject: 'Maths', lessonType: 'consultation', studentLevel: 'gcse',
        startTime: new Date(base + i * 3 * 60000).toISOString(),
      },
    }, res).then(() => res);
  });

  const results = await Promise.all(requests);
  const succeeded = results.filter((r) => r.statusCode === 200);
  assert.equal(succeeded.length, 1, 'staggered-but-overlapping slots for the same tutor must still only let one through');
});
