const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWithMocks, makeRes } = require('./helpers/loadWithMocks');

function confirmReq(overrides = {}) {
  return {
    query: { action: 'confirm' },
    body: {
      studentName: 'S', parentName: 'P', parentEmail: 'p@example.com',
      tutorName: 'Azeem', subject: 'Maths', lessonType: 'trial', studentLevel: 'gcse',
      startTime: new Date().toISOString(), paymentIntentId: 'pi_test',
      ...overrides,
    },
  };
}

test('confirm booking succeeds and creates a new student when none exists', async () => {
  const handler = loadWithMocks('api/bookings.js', {
    db: { dbGet: async () => [], dbPost: async (p) => (p === '/bookings' ? { id: 'b1' } : { id: 'student1' }) },
  });
  const res = makeRes();
  await handler(confirmReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
});

test('confirm booking is rate-limited by IP (SCRUM-20)', async () => {
  const handler = loadWithMocks('api/bookings.js', {
    db: { dbGet: async () => [], dbRpc: async () => false },
  });
  const res = makeRes();
  await handler(confirmReq(), res);
  assert.equal(res.statusCode, 429);
});

test('confirm booking reuses an existing student by parent email', async () => {
  let studentCreated = false;
  const handler = loadWithMocks('api/bookings.js', {
    db: {
      dbGet: async (p) => (p.startsWith('/students') ? [{ id: 'existing-student' }] : []),
      dbPost: async (p) => {
        if (p === '/students') studentCreated = true;
        return { id: 'b1' };
      },
    },
  });
  const res = makeRes();
  await handler(confirmReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(studentCreated, false, 'should not create a duplicate student record');
});

test('confirm booking normalizes email casing before matching/storing (SCRUM-13 follow-up)', async () => {
  let queriedPath, postedEmail;
  const handler = loadWithMocks('api/bookings.js', {
    db: {
      dbGet: async (p) => { if (p.startsWith('/students')) queriedPath = p; return []; },
      dbPost: async (p, body) => {
        if (p === '/students') { postedEmail = body.parent_email; return { id: 'student1' }; }
        return { id: 'b1' };
      },
    },
  });
  const res = makeRes();
  await handler(confirmReq({ parentEmail: 'MixedCase@Example.COM' }), res);
  assert.equal(res.statusCode, 200);
  assert.match(queriedPath, /parent_email=eq\.mixedcase%40example\.com/i);
  assert.equal(postedEmail, 'mixedcase@example.com');
});

test('confirm booking persists a new student\'s Stripe customer id when given', async () => {
  let posted;
  const handler = loadWithMocks('api/bookings.js', {
    db: {
      dbGet: async () => [],
      dbPost: async (p, body) => {
        if (p === '/students') { posted = body; return { id: 'student1', stripe_customer_id: body.stripe_customer_id }; }
        return { id: 'b1' };
      },
    },
  });
  const res = makeRes();
  await handler(confirmReq({ customerId: 'cus_123' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(posted.stripe_customer_id, 'cus_123');
});

test('confirm booking backfills an existing student\'s missing Stripe customer id', async () => {
  let patched;
  const handler = loadWithMocks('api/bookings.js', {
    db: {
      dbGet: async (p) => (p.startsWith('/students') ? [{ id: 'existing-student', stripe_customer_id: null }] : []),
      dbPost: async (p) => (p === '/bookings' ? { id: 'b1' } : { id: 'existing-student' }),
      dbPatch: async (p, body) => { patched = { p, body }; },
    },
  });
  const res = makeRes();
  await handler(confirmReq({ customerId: 'cus_456' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(patched.p, '/students?id=eq.existing-student');
  assert.equal(patched.body.stripe_customer_id, 'cus_456');
});

test('confirm booking returns a friendly 409 on tutor double-booking', async () => {
  const handler = loadWithMocks('api/bookings.js', {
    db: {
      dbGet: async () => [],
      dbPost: async (p) => {
        if (p === '/bookings') throw new Error('conflicting key value violates exclusion constraint "bookings_no_tutor_overlap"');
        return { id: 'student1' };
      },
    },
  });
  const res = makeRes();
  await handler(confirmReq(), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.conflict, true);
  assert.match(res.body.error, /Azeem/);
});

test('confirm booking returns a friendly 409 when the student already used their trial', async () => {
  const handler = loadWithMocks('api/bookings.js', {
    db: {
      dbGet: async () => [],
      dbPost: async (p) => {
        if (p === '/bookings') throw new Error('duplicate key value violates unique constraint "bookings_one_trial_per_student"');
        return { id: 'student1' };
      },
    },
  });
  const res = makeRes();
  await handler(confirmReq(), res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /trial/);
});

test('confirm booking rejects a request missing required fields', async () => {
  const handler = loadWithMocks('api/bookings.js');
  const res = makeRes();
  await handler(confirmReq({ tutorName: undefined }), res);
  assert.equal(res.statusCode, 400);
});

test('confirm booking pre-check catches an existing conflicting booking before insert', async () => {
  const handler = loadWithMocks('api/bookings.js', {
    db: {
      dbGet: async (p) => (p.startsWith('/bookings?tutor_name') ? [{ id: 'conflicting' }] : []),
    },
  });
  const res = makeRes();
  await handler(confirmReq(), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.conflict, true);
});

// ── action=calendly-link ────────────────────────────────────────────────────
test('calendly-link returns a fresh scheduling URL for a tutor with a configured event type', async () => {
  let queriedPath;
  const handler = loadWithMocks('api/bookings.js', {
    db: { dbGet: async (p) => { queriedPath = p; return [{ calendly_event_type_uri: 'https://api.calendly.com/event_types/abc' }]; } },
    calendly: { createSchedulingLink: async ({ eventTypeUri }) => `https://calendly.com/booked?src=${eventTypeUri}` },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { action: 'calendly-link', tutorName: 'Azeem Omar-Mufti' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.url, 'https://calendly.com/booked?src=https://api.calendly.com/event_types/abc');
  assert.match(queriedPath, /^\/tutors\?name=eq\./, 'should read from the canonical tutors table, not profiles');
});

test('calendly-link returns a plain public Calendly URL directly, without minting a single-use link', async () => {
  let mintCalled = false;
  const handler = loadWithMocks('api/bookings.js', {
    db: { dbGet: async () => [{ calendly_event_type_uri: 'https://calendly.com/roots-academy/30min' }] },
    calendly: { createSchedulingLink: async () => { mintCalled = true; return 'should-not-be-used'; } },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { action: 'calendly-link', tutorName: 'Suleiman' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.url, 'https://calendly.com/roots-academy/30min');
  assert.equal(mintCalled, false);
});

test('calendly-link for "Best available match" uses any tutor with scheduling configured', async () => {
  let queriedPath;
  const handler = loadWithMocks('api/bookings.js', {
    db: { dbGet: async (p) => { queriedPath = p; return [{ calendly_event_type_uri: 'https://calendly.com/roots-academy/30min' }]; } },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { action: 'calendly-link', tutorName: 'Best available match' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.url, 'https://calendly.com/roots-academy/30min');
  assert.match(queriedPath, /calendly_event_type_uri=not\.is\.null/);
});

test('calendly-link uses the trial event type for a trial lessonType', async () => {
  const handler = loadWithMocks('api/bookings.js', {
    db: {
      dbGet: async () => [{
        calendly_trial_event_type_uri: 'https://calendly.com/roots-academy/initial-consultation',
        calendly_event_type_uri: 'https://calendly.com/roots-academy/30min',
      }],
    },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { action: 'calendly-link', tutorName: 'Suleiman', lessonType: 'trial' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.url, 'https://calendly.com/roots-academy/initial-consultation');
});

test('calendly-link falls back to the lesson event type when no trial-specific one is configured', async () => {
  const handler = loadWithMocks('api/bookings.js', {
    db: { dbGet: async () => [{ calendly_trial_event_type_uri: null, calendly_event_type_uri: 'https://calendly.com/roots-academy/30min' }] },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { action: 'calendly-link', tutorName: 'Suleiman', lessonType: 'trial' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.url, 'https://calendly.com/roots-academy/30min');
});

test('calendly-link 404s for a tutor with no Calendly event type configured', async () => {
  const handler = loadWithMocks('api/bookings.js', {
    db: { dbGet: async () => [] },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { action: 'calendly-link', tutorName: 'Suleiman' } }, res);
  assert.equal(res.statusCode, 404);
});

test('calendly-link requires tutorName', async () => {
  const handler = loadWithMocks('api/bookings.js');
  const res = makeRes();
  await handler({ method: 'GET', query: { action: 'calendly-link' } }, res);
  assert.equal(res.statusCode, 400);
});

// ── action=calendly-event ───────────────────────────────────────────────────
test('calendly-event returns the real start/end time for a valid Calendly event URI', async () => {
  const handler = loadWithMocks('api/bookings.js', {
    calendly: { getScheduledEvent: async () => ({ startTime: '2026-08-01T10:00:00Z', endTime: '2026-08-01T10:55:00Z' }) },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { action: 'calendly-event', eventUri: 'https://api.calendly.com/scheduled_events/xyz' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { startTime: '2026-08-01T10:00:00Z', endTime: '2026-08-01T10:55:00Z' });
});

test('calendly-event rejects a non-Calendly eventUri (SSRF guard)', async () => {
  const handler = loadWithMocks('api/bookings.js');
  const res = makeRes();
  await handler({ method: 'GET', query: { action: 'calendly-event', eventUri: 'https://evil.example.com/steal-token' } }, res);
  assert.equal(res.statusCode, 400);
});

test('calendly-event requires eventUri', async () => {
  const handler = loadWithMocks('api/bookings.js');
  const res = makeRes();
  await handler({ method: 'GET', query: { action: 'calendly-event' } }, res);
  assert.equal(res.statusCode, 400);
});
