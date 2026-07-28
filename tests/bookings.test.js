const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWithMocks, makeRes } = require('./helpers/loadWithMocks');

function confirmReq(overrides = {}) {
  return {
    query: { action: 'confirm' },
    body: {
      studentName: 'S', parentName: 'P', parentEmail: 'p@example.com',
      tutorName: 'Azeem', subject: 'Maths', lessonType: 'consultation', studentLevel: 'gcse',
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

// SCRUM-58: the public wizard's free consultation now has its own
// lesson_type ('consultation'), separate from the portal-booked trial
// lesson ('trial') — they used to share one type, which also meant the
// old bookings_one_trial_per_student index blocked a family from ever
// booking their real trial lesson once they'd already had a consultation.
test('confirm booking returns a friendly 409 when the student already booked their consultation', async () => {
  const handler = loadWithMocks('api/bookings.js', {
    db: {
      dbGet: async () => [],
      dbPost: async (p) => {
        if (p === '/bookings') throw new Error('duplicate key value violates unique constraint "bookings_one_consultation_per_student"');
        return { id: 'student1' };
      },
    },
  });
  const res = makeRes();
  await handler(confirmReq(), res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /Consultation/);
});

// This is the PUBLIC homepage wizard's endpoint — under periodic billing,
// only the free Initial Consultation can be booked here at all; paid
// lessons go through the authenticated portal
// (api/lifecycle.js?resource=lessons) instead. Without this guard, a
// direct API call (bypassing the frontend entirely, which no longer
// offers non-consultation options) could still create a paid booking
// through the public, unauthenticated wizard flow.
test('confirm booking rejects any lessonType other than consultation', async () => {
  const handler = loadWithMocks('api/bookings.js', {
    db: { dbGet: async () => [], dbPost: async (p) => (p === '/bookings' ? { id: 'b1' } : { id: 'student1' }) },
  });
  const res = makeRes();
  await handler(confirmReq({ lessonType: 'gcse' }), res);
  assert.equal(res.statusCode, 400);
});

test('confirm booking creates the consultation as payment_status=free', async () => {
  let posted;
  const handler = loadWithMocks('api/bookings.js', {
    db: {
      dbGet: async () => [],
      dbPost: async (p, body) => {
        if (p === '/bookings') { posted = body; return { id: 'b1' }; }
        return { id: 'student1' };
      },
    },
    pricing: { resolvePrice: () => ({ duration: 15, amount: 0 }) },
  });
  const res = makeRes();
  await handler(confirmReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(posted.lesson_type, 'consultation');
  assert.equal(posted.fee_pence, 0);
  assert.equal(posted.payment_status, 'free');
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

// ── action=scheduling-link ──────────────────────────────────────────────────
test('scheduling-link returns the tutor\'s own Cal.com lesson link by default', async () => {
  let queriedPath;
  const handler = loadWithMocks('api/bookings.js', {
    db: { dbGet: async (p) => { queriedPath = p; return [{ cal_lesson_link: 'https://cal.eu/azeem-mufti-h4oqbq/lesson' }]; } },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { action: 'scheduling-link', tutorName: 'Azeem Omar-Mufti' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.url, 'https://cal.eu/azeem-mufti-h4oqbq/lesson');
  assert.match(queriedPath, /^\/tutors\?name=eq\./, 'should read from the canonical tutors table, not profiles');
  assert.match(queriedPath, /select=cal_lesson_link/);
});

test('scheduling-link for "Best available match" uses any tutor with that link configured', async () => {
  let queriedPath;
  const handler = loadWithMocks('api/bookings.js', {
    db: { dbGet: async (p) => { queriedPath = p; return [{ cal_lesson_link: 'https://cal.eu/roots-academy/lesson' }]; } },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { action: 'scheduling-link', tutorName: 'Best available match' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.url, 'https://cal.eu/roots-academy/lesson');
  assert.match(queriedPath, /cal_lesson_link=not\.is\.null/);
});

// Each tutor has their own individual Cal.com account (unlimited free event
// types), unlike Calendly's free plan which forced every context onto one
// shared link — context/lessonType now genuinely pick a different column.
test('scheduling-link picks cal_consultation_link for context=consultation', async () => {
  let queriedPath;
  const handler = loadWithMocks('api/bookings.js', {
    db: { dbGet: async (p) => { queriedPath = p; return [{ cal_consultation_link: 'https://cal.eu/azeem-mufti-h4oqbq/15min' }]; } },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { action: 'scheduling-link', tutorName: 'Azeem Omar-Mufti', context: 'consultation' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.url, 'https://cal.eu/azeem-mufti-h4oqbq/15min');
  assert.match(queriedPath, /select=cal_consultation_link/);
});

test('scheduling-link picks cal_trial_link for lessonType=trial', async () => {
  const handler = loadWithMocks('api/bookings.js', {
    db: { dbGet: async () => [{ cal_trial_link: 'https://cal.eu/azeem-mufti-h4oqbq/60min' }] },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { action: 'scheduling-link', tutorName: 'Azeem Omar-Mufti', lessonType: 'trial' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.url, 'https://cal.eu/azeem-mufti-h4oqbq/60min');
});

test('scheduling-link picks cal_lesson_link for any other paid lesson type', async () => {
  const handler = loadWithMocks('api/bookings.js', {
    db: { dbGet: async () => [{ cal_lesson_link: 'https://cal.eu/azeem-mufti-h4oqbq/lesson' }] },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { action: 'scheduling-link', tutorName: 'Azeem Omar-Mufti', lessonType: 'gcse' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.url, 'https://cal.eu/azeem-mufti-h4oqbq/lesson');
});

test('scheduling-link 404s for a tutor with no Cal.com link configured for that context', async () => {
  const handler = loadWithMocks('api/bookings.js', {
    db: { dbGet: async () => [] },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { action: 'scheduling-link', tutorName: 'Suleiman' } }, res);
  assert.equal(res.statusCode, 404);
});

test('scheduling-link requires tutorName', async () => {
  const handler = loadWithMocks('api/bookings.js');
  const res = makeRes();
  await handler({ method: 'GET', query: { action: 'scheduling-link' } }, res);
  assert.equal(res.statusCode, 400);
});
