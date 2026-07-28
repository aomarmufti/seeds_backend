const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWithMocks, makeRes } = require('./helpers/loadWithMocks');

// SCRUM-13: notes/homework/progress/lessons/availability/charge-student
// previously had zero auth or ownership checks — any caller who knew or
// guessed a studentId/tutorName/bookingId could read or write another
// family's private data, impersonate a tutor, or direct a real Stripe
// charge. These tests exercise the ownership boundary itself, not just
// "does it require a token".

const unrelatedCaller = { id: 'stranger-1', role: 'student', email: 'stranger@example.com' };
const parentCaller = { id: 'parent-1', role: 'student', email: 'parent@example.com' };
const tutorCaller = { id: 'tutor-1', role: 'tutor', email: 'tutor@example.com' };

function dbForOwnership({ parentEmail = 'parent@example.com', tutorName = 'Azeem Omar-Mufti', hasBooking = true } = {}) {
  return {
    dbGet: async (path) => {
      if (path.startsWith('/students?id=eq.')) return [{ parent_email: parentEmail }];
      if (path.startsWith('/students?parent_email=eq.')) return [{ id: 'student-1' }];
      if (path.startsWith('/profiles?id=eq.')) return [{ tutor_name: tutorName }];
      if (path.startsWith('/bookings?student_id=eq.')) return hasBooking ? [{ id: 'b1' }] : [];
      if (path.startsWith(`/lesson_notes?id=eq.`) || path.startsWith('/homework?id=eq.') || path.startsWith('/progress?id=eq.')) {
        return [{ student_id: 'student-1' }];
      }
      return [];
    },
    dbPost: async () => ({ id: 'created-1' }),
  };
}

// ── notes/homework/progress GET ─────────────────────────────────────────
test('resource=notes GET requires authentication', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async (req, res) => { res.status(401).json({ error: 'Unauthorized' }); return null; } },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'notes', studentId: 'student-1' } }, res);
  assert.equal(res.statusCode, 401);
});

test('resource=notes GET rejects a caller with no relationship to the student', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => unrelatedCaller },
    db: dbForOwnership({ hasBooking: false }),
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'notes', studentId: 'student-1' } }, res);
  assert.equal(res.statusCode, 403);
});

test('resource=notes GET allows the student\'s own parent', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => parentCaller },
    db: dbForOwnership(),
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'notes', studentId: 'student-1' } }, res);
  assert.equal(res.statusCode, 200);
});

test('resource=notes GET allows the assigned tutor', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: dbForOwnership({ parentEmail: 'someone-else@example.com' }),
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'notes', studentId: 'student-1' } }, res);
  assert.equal(res.statusCode, 200);
});

test('resource=notes GET by studentEmail rejects lookup of another parent\'s email', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => parentCaller },
    db: dbForOwnership(),
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'notes', studentEmail: 'someone-else@example.com' } }, res);
  assert.equal(res.statusCode, 403);
});

// ── notes/homework/progress POST ────────────────────────────────────────
test('resource=homework POST rejects a tutor with no real booking for that student', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: dbForOwnership({ hasBooking: false }),
  });
  const res = makeRes();
  await handler({ method: 'POST', query: { resource: 'homework' }, body: { studentId: 'student-1', tutorName: 'Azeem Omar-Mufti', title: 'Past paper' } }, res);
  assert.equal(res.statusCode, 403);
});

test('resource=homework POST allows the tutor with a real booking for that student', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: dbForOwnership(),
  });
  const res = makeRes();
  await handler({ method: 'POST', query: { resource: 'homework' }, body: { studentId: 'student-1', tutorName: 'Azeem Omar-Mufti', title: 'Past paper' } }, res);
  assert.equal(res.statusCode, 201);
});

test('resource=homework POST rejects a parent trying to set homework (tutor-only action)', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => parentCaller },
    db: dbForOwnership({ hasBooking: false }),
  });
  const res = makeRes();
  await handler({ method: 'POST', query: { resource: 'homework' }, body: { studentId: 'student-1', tutorName: 'Azeem Omar-Mufti', title: 'Past paper' } }, res);
  assert.equal(res.statusCode, 403);
});

// ── homework PATCH ──────────────────────────────────────────────────────
test('resource=homework PATCH checks the row\'s own student_id, allows the parent', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => parentCaller },
    db: dbForOwnership(),
  });
  const res = makeRes();
  await handler({ method: 'PATCH', query: { resource: 'homework' }, body: { id: 'hw-1', completed: true } }, res);
  assert.equal(res.statusCode, 200);
});

test('resource=homework PATCH rejects an unrelated caller regardless of body claims', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => unrelatedCaller },
    db: dbForOwnership({ hasBooking: false }),
  });
  const res = makeRes();
  await handler({ method: 'PATCH', query: { resource: 'homework' }, body: { id: 'hw-1', completed: true } }, res);
  assert.equal(res.statusCode, 403);
});

// ── lessons ──────────────────────────────────────────────────────────────
test('resource=lessons rejects a caller who is neither the named tutor nor the student\'s parent', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => unrelatedCaller },
    db: {
      // The stranger has no tutor_name of their own, and isn't this
      // student's parent either — dbForOwnership's default fixture assumes
      // a single shared tutor identity, which doesn't fit this case.
      dbGet: async (path) => {
        if (path.startsWith('/students?id=eq.')) return [{ parent_email: 'parent@example.com' }];
        if (path.startsWith('/profiles?id=eq.')) return [{ tutor_name: null }];
        if (path.startsWith('/bookings?student_id=eq.')) return [];
        return [];
      },
    },
  });
  const res = makeRes();
  await handler({ method: 'POST', query: { resource: 'lessons' }, body: { studentId: 'student-1', tutorName: 'Azeem Omar-Mufti', subject: 'Maths', startTime: new Date().toISOString() } }, res);
  assert.equal(res.statusCode, 403);
});

test('resource=lessons allows the named tutor even with no prior booking (first-ever lesson)', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: { ...dbForOwnership({ hasBooking: false }), dbGet: async (path) => {
      if (path.startsWith('/profiles?id=eq.')) return [{ tutor_name: 'Azeem Omar-Mufti' }];
      if (path.startsWith('/bookings?tutor_name=eq.') && path.includes('status=neq.cancelled')) return [];
      return [];
    } },
  });
  const res = makeRes();
  await handler({ method: 'POST', query: { resource: 'lessons' }, body: { studentId: 'student-1', tutorName: 'Azeem Omar-Mufti', subject: 'Maths', startTime: new Date().toISOString() } }, res);
  assert.equal(res.statusCode, 201);
});

test('resource=lessons creates a trial booking as confirmed immediately (free, nothing to pay)', async () => {
  let posted;
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: {
      ...dbForOwnership({ hasBooking: false }),
      dbGet: async (path) => {
        if (path.startsWith('/profiles?id=eq.')) return [{ tutor_name: 'Azeem Omar-Mufti' }];
        if (path.startsWith('/bookings?tutor_name=eq.') && path.includes('status=neq.cancelled')) return [];
        return [];
      },
      dbPost: async (path, body) => { if (path === '/bookings') posted = body; return { id: 'b1', ...body }; },
    },
  });
  const res = makeRes();
  await handler({
    method: 'POST', query: { resource: 'lessons' },
    body: { studentId: 'student-1', tutorName: 'Azeem Omar-Mufti', subject: 'Maths', lessonType: 'trial', startTime: new Date().toISOString() },
  }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(posted.status, 'confirmed');
  assert.equal(posted.payment_status, 'free', 'a free trial has nothing to bill, ever');
});

// SCRUM-69: the student portal now offers booking a free trial lesson,
// making bookings_one_trial_per_student reachable through a real user
// flow for the first time. The frontend gates the option client-side,
// but the DB constraint is the real backstop for races (e.g. two tabs) —
// same friendly-409 treatment as the sibling consultation constraint in
// api/bookings.js.
test('resource=lessons returns a friendly 409 when the student already has a trial booking', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: {
      ...dbForOwnership({ hasBooking: false }),
      dbGet: async (path) => {
        if (path.startsWith('/profiles?id=eq.')) return [{ tutor_name: 'Azeem Omar-Mufti' }];
        if (path.startsWith('/bookings?tutor_name=eq.') && path.includes('status=neq.cancelled')) return [];
        return [];
      },
      dbPost: async (path) => {
        if (path === '/bookings') throw new Error('duplicate key value violates unique constraint "bookings_one_trial_per_student"');
        return { id: 'b1' };
      },
    },
  });
  const res = makeRes();
  await handler({
    method: 'POST', query: { resource: 'lessons' },
    body: { studentId: 'student-1', tutorName: 'Azeem Omar-Mufti', subject: 'Maths', lessonType: 'trial', startTime: new Date().toISOString() },
  }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.conflict, true);
  assert.match(res.body.error, /trial/i);
});

// Periodic billing replaced book-now-pay-now entirely: a lesson's own
// status is 'confirmed' the moment it's booked regardless of lesson type —
// payment is deferred to the family's own weekly/monthly billing cycle
// (api/billing.js resource=billing-cron) rather than gating the booking
// itself. payment_status is the only thing that tracks whether it's
// actually been paid for.
test('resource=lessons creates a paid booking as confirmed immediately, with payment_status=unbilled', async () => {
  let posted;
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: {
      ...dbForOwnership({ hasBooking: false }),
      dbGet: async (path) => {
        if (path.startsWith('/profiles?id=eq.')) return [{ tutor_name: 'Azeem Omar-Mufti' }];
        if (path.startsWith('/bookings?tutor_name=eq.') && path.includes('status=neq.cancelled')) return [];
        return [];
      },
      dbPost: async (path, body) => { if (path === '/bookings') posted = body; return { id: 'b1', ...body }; },
    },
  });
  const res = makeRes();
  await handler({
    method: 'POST', query: { resource: 'lessons' },
    body: { studentId: 'student-1', tutorName: 'Azeem Omar-Mufti', subject: 'Maths', lessonType: 'gcse', startTime: new Date().toISOString() },
  }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(posted.status, 'confirmed');
  assert.equal(posted.payment_status, 'unbilled');
});

test('resource=lessons self-heals a missing students row for a student/parent booking their own first lesson', async () => {
  let posted;
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => parentCaller },
    db: {
      dbGet: async (path) => {
        if (path.startsWith('/profiles?id=eq.')) return [{ tutor_name: null }];
        if (path.startsWith('/students?parent_email=eq.')) return [];
        if (path.startsWith('/bookings?tutor_name=eq.')) return [];
        return [];
      },
      dbPost: async (path, body) => {
        if (path === '/students') { posted = body; return { id: 'new-student-1' }; }
        return { id: 'booking-1', student_id: body.student_id };
      },
    },
  });
  const res = makeRes();
  await handler({
    method: 'POST', query: { resource: 'lessons' },
    body: { tutorName: 'Azeem Omar-Mufti', subject: 'Maths', startTime: new Date().toISOString(), studentName: 'Jamie' },
  }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(posted.parent_email, 'parent@example.com');
  assert.equal(res.body.bookings[0].student_id, 'new-student-1');
});

test('resource=lessons requires studentId when the caller is the tutor themselves', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: { dbGet: async (path) => path.startsWith('/profiles?id=eq.') ? [{ tutor_name: 'Azeem Omar-Mufti' }] : [] },
  });
  const res = makeRes();
  await handler({
    method: 'POST', query: { resource: 'lessons' },
    body: { tutorName: 'Azeem Omar-Mufti', subject: 'Maths', startTime: new Date().toISOString() },
  }, res);
  assert.equal(res.statusCode, 400);
});

// Live bug: leaving Subject blank in the student/tutor portal's booking
// modal sent subject: null straight through to a NOT-NULL column, crashing
// with a raw Postgres error instead of a friendly validation message.
test('resource=lessons requires subject', async () => {
  const handler = loadWithMocks('api/lifecycle.js');
  const res = makeRes();
  await handler({
    method: 'POST', query: { resource: 'lessons' },
    body: { studentId: 'student-1', tutorName: 'Azeem Omar-Mufti', startTime: new Date().toISOString() },
  }, res);
  assert.equal(res.statusCode, 400);
});

// ── charge-student ───────────────────────────────────────────────────────
test('resource=charge-student derives the amount/email from the booking, ignoring any client-supplied override', async () => {
  let stripeCustomersListArgs;
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: {
      dbGet: async (path) => {
        if (path.startsWith('/profiles?id=eq.')) return [{ tutor_name: 'Azeem Omar-Mufti' }];
        if (path.startsWith('/bookings?id=eq.')) {
          return [{
            id: 'booking-1', tutor_name: 'Azeem Omar-Mufti', subject: 'Maths',
            start_time: new Date().toISOString(), lesson_type: 'gcse',
            students: { student_name: 'Real Student', parent_email: 'real-parent@example.com' },
          }];
        }
        return [];
      },
      supabaseRequest: async () => ({ ok: true, json: async () => ({}) }),
    },
  });
  const stripeModulePath = require.resolve('stripe');
  require.cache[stripeModulePath] = {
    id: stripeModulePath, filename: stripeModulePath, loaded: true,
    exports: () => ({
      customers: { list: async (args) => { stripeCustomersListArgs = args; return { data: [] }; } },
      checkout: { sessions: { create: async () => ({ url: 'https://checkout.stripe.com/session_1' }) } },
    }),
  };
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  const res = makeRes();
  await handler({
    method: 'POST', query: { resource: 'charge-student' },
    body: {
      bookingId: 'booking-1',
      // Attacker-supplied overrides — none of these should be trusted.
      studentEmail: 'attacker@example.com', lessonType: 'alevel', studentLevel: 'alevel',
    },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(stripeCustomersListArgs.email, 'real-parent@example.com');
});

test('resource=charge-student allows the student\'s own parent proactively paying', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => parentCaller },
    db: {
      dbGet: async (path) => {
        if (path.startsWith('/profiles?id=eq.')) return [{ tutor_name: null }];
        if (path.startsWith('/students?id=eq.')) return [{ parent_email: 'parent@example.com' }];
        if (path.startsWith('/bookings?id=eq.')) {
          return [{
            id: 'booking-1', student_id: 'student-1', tutor_name: 'Azeem Omar-Mufti', subject: 'Maths',
            start_time: new Date().toISOString(), lesson_type: 'gcse',
            students: { student_name: 'Real Student', parent_email: 'parent@example.com' },
          }];
        }
        return [];
      },
      supabaseRequest: async () => ({ ok: true, json: async () => ({}) }),
    },
  });
  const stripeModulePath = require.resolve('stripe');
  require.cache[stripeModulePath] = {
    id: stripeModulePath, filename: stripeModulePath, loaded: true,
    exports: () => ({
      customers: { list: async () => ({ data: [] }) },
      checkout: { sessions: { create: async () => ({ url: 'https://checkout.stripe.com/session_1' }) } },
    }),
  };
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  const res = makeRes();
  await handler({ method: 'POST', query: { resource: 'charge-student' }, body: { bookingId: 'booking-1' } }, res);
  assert.equal(res.statusCode, 200);
});

test('resource=charge-student rejects a tutor who does not own the booking', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: {
      dbGet: async (path) => {
        if (path.startsWith('/profiles?id=eq.')) return [{ tutor_name: 'Someone Else' }];
        if (path.startsWith('/bookings?id=eq.')) {
          return [{ id: 'booking-1', tutor_name: 'Azeem Omar-Mufti', lesson_type: 'gcse', students: { parent_email: 'p@example.com' } }];
        }
        return [];
      },
    },
  });
  const res = makeRes();
  await handler({ method: 'POST', query: { resource: 'charge-student' }, body: { bookingId: 'booking-1' } }, res);
  assert.equal(res.statusCode, 403);
});

test('resource=charge-student marks the booking payment_failed on a declined saved card', async () => {
  let patched;
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: {
      dbGet: async (path) => {
        if (path.startsWith('/profiles?id=eq.')) return [{ tutor_name: 'Azeem Omar-Mufti' }];
        if (path.startsWith('/bookings?id=eq.')) {
          return [{
            id: 'booking-1', tutor_name: 'Azeem Omar-Mufti', subject: 'Maths',
            start_time: new Date().toISOString(), lesson_type: 'gcse',
            students: { student_name: 'Real Student', parent_email: 'real-parent@example.com' },
          }];
        }
        return [];
      },
      supabaseRequest: async (path, opts) => {
        if (path.startsWith('/bookings?id=eq.')) patched = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      },
    },
  });
  const stripeModulePath = require.resolve('stripe');
  const declinedError = Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError', code: 'card_declined' });
  require.cache[stripeModulePath] = {
    id: stripeModulePath, filename: stripeModulePath, loaded: true,
    exports: () => ({
      customers: { list: async () => ({ data: [{ id: 'cus_1' }] }) },
      paymentMethods: { list: async () => ({ data: [{ id: 'pm_1' }] }) },
      paymentIntents: { create: async () => { throw declinedError; } },
    }),
  };
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  const res = makeRes();
  await handler({ method: 'POST', query: { resource: 'charge-student' }, body: { bookingId: 'booking-1' } }, res);
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.status, 'failed');
  assert.equal(res.body.error, 'card_declined');
  assert.equal(patched.status, 'payment_failed');
  assert.equal(patched.payment_status, 'failed');
});

test('resource=charge-student marks the booking payment_status=paid on a successful saved-card charge', async () => {
  let patched;
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: {
      dbGet: async (path) => {
        if (path.startsWith('/profiles?id=eq.')) return [{ tutor_name: 'Azeem Omar-Mufti' }];
        if (path.startsWith('/bookings?id=eq.')) {
          return [{
            id: 'booking-1', tutor_name: 'Azeem Omar-Mufti', subject: 'Maths',
            start_time: new Date().toISOString(), lesson_type: 'gcse',
            students: { student_name: 'Real Student', parent_email: 'real-parent@example.com' },
          }];
        }
        return [];
      },
      supabaseRequest: async (path, opts) => {
        if (path.startsWith('/bookings?id=eq.')) patched = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      },
    },
  });
  const stripeModulePath = require.resolve('stripe');
  require.cache[stripeModulePath] = {
    id: stripeModulePath, filename: stripeModulePath, loaded: true,
    exports: () => ({
      customers: { list: async () => ({ data: [{ id: 'cus_1' }] }) },
      paymentMethods: { list: async () => ({ data: [{ id: 'pm_1' }] }) },
      paymentIntents: { create: async () => ({ id: 'pi_1' }) },
    }),
  };
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  const res = makeRes();
  await handler({ method: 'POST', query: { resource: 'charge-student' }, body: { bookingId: 'booking-1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'charged');
  assert.equal(patched.status, 'confirmed');
  assert.equal(patched.payment_status, 'paid');
});

// ── auto-payout ───────────────────────────────────────────────────────────
// Daily cron (SCRUM-76) that pays each tutor 78% of what's owed on whichever
// cadence the admin set for them (tutor_accounts.payout_cycle), the same
// weekly-Sunday/monthly-1st split api/billing.js's billing-cron already uses
// for student billing. Under periodic billing a booking's own status is
// 'confirmed' the moment it's made regardless of whether the family has been
// charged yet, so this must also require payment_status='paid' or it would
// pay tutors out of money never actually collected.
test('resource=auto-payout only pays tutors for bookings the student has actually paid for', async (t) => {
  process.env.CRON_SECRET = 'shh';
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-02T05:00:00Z') }); // Sunday
  const queriedPaths = [];
  const handler = loadWithMocks('api/lifecycle.js', {
    db: {
      dbGet: async (p) => {
        if (p.startsWith('/tutor_accounts')) return [{ tutor_name: 'Azeem Omar-Mufti', onboarding_complete: true, stripe_account_id: 'acct_1', payout_cycle: 'weekly' }];
        if (p.startsWith('/bookings?')) { queriedPaths.push(p); return []; }
        return [];
      },
    },
  });
  const stripeModulePath = require.resolve('stripe');
  require.cache[stripeModulePath] = {
    id: stripeModulePath, filename: stripeModulePath, loaded: true,
    exports: () => ({ transfers: { create: async () => ({ id: 'tr_1' }) } }),
  };
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'auto-payout' }, headers: { authorization: 'Bearer shh' } }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(queriedPaths.length > 0);
  queriedPaths.forEach(p => {
    assert.ok(p.includes('status=eq.confirmed'));
    assert.ok(p.includes('payment_status=eq.paid'), 'must not pay a tutor for an unbilled or declined lesson');
    assert.ok(p.includes('end_time=lte.'), 'must not pay a tutor for a lesson that hasn\'t happened yet');
  });
});

test('resource=auto-payout is a no-op on a day that is neither a Sunday nor the 1st of the month', async (t) => {
  process.env.CRON_SECRET = 'shh';
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-05T05:00:00Z') }); // Wednesday the 5th
  const handler = loadWithMocks('api/lifecycle.js');
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'auto-payout' }, headers: { authorization: 'Bearer shh' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.processed, 0);
});

// SCRUM-76: a monthly-cycle tutor must not be paid on a plain Sunday, only
// on the 1st — and a weekly-cycle tutor must not be paid on the 1st unless
// it also happens to be a Sunday. Each cadence only fires on its own day.
test('resource=auto-payout only pays a monthly-cycle tutor on the 1st, not on a regular Sunday', async (t) => {
  process.env.CRON_SECRET = 'shh';
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-02T05:00:00Z') }); // Sunday, not the 1st
  const queriedPaths = [];
  const handler = loadWithMocks('api/lifecycle.js', {
    db: {
      dbGet: async (p) => {
        if (p.startsWith('/tutor_accounts')) return [{ tutor_name: 'Suleiman', onboarding_complete: true, stripe_account_id: 'acct_2', payout_cycle: 'monthly' }];
        if (p.startsWith('/bookings?')) { queriedPaths.push(p); return []; }
        return [];
      },
    },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'auto-payout' }, headers: { authorization: 'Bearer shh' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(queriedPaths.length, 0, 'a monthly-cycle tutor must not be processed on a plain Sunday');
});

// ── progress-history ─────────────────────────────────────────────────────
test('resource=progress-history rejects a studentId the caller has no relationship to', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => unrelatedCaller },
    db: dbForOwnership({ hasBooking: false }),
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'progress-history', studentId: 'student-1' } }, res);
  assert.equal(res.statusCode, 403);
});

test('resource=progress-history resolves the caller\'s own student when no studentId given', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => parentCaller },
    db: dbForOwnership(),
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'progress-history' } }, res);
  assert.equal(res.statusCode, 200);
});
