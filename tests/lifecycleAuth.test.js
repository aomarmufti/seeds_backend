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
  await handler({ method: 'POST', query: { resource: 'lessons' }, body: { studentId: 'student-1', tutorName: 'Azeem Omar-Mufti', startTime: new Date().toISOString() } }, res);
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
  await handler({ method: 'POST', query: { resource: 'lessons' }, body: { studentId: 'student-1', tutorName: 'Azeem Omar-Mufti', startTime: new Date().toISOString() } }, res);
  assert.equal(res.statusCode, 201);
});

// ── availability ─────────────────────────────────────────────────────────
test('resource=availability GET rejects a caller who is not that tutor', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: { dbGet: async (path) => path.startsWith('/profiles?id=eq.') ? [{ tutor_name: 'Someone Else' }] : [] },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'availability', tutorName: 'Azeem Omar-Mufti' } }, res);
  assert.equal(res.statusCode, 403);
});

test('resource=availability GET allows the matching tutor', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: { dbGet: async (path) => {
      if (path.startsWith('/profiles?id=eq.')) return [{ tutor_name: 'Azeem Omar-Mufti' }];
      if (path.startsWith('/profiles?tutor_name=eq.')) return [{ availability: ['Mon:10:00'] }];
      return [];
    } },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'availability', tutorName: 'Azeem Omar-Mufti' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { slots: ['Mon:10:00'] });
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
