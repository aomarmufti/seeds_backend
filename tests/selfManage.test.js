// SCRUM-57: a tutor cancelling or rescheduling their OWN lesson, without
// an admin. Ownership is enforced the same way as every other
// tutor-scoped endpoint (verifyTutorIdentity via lib/auth's caller +
// profiles.tutor_name), and cancellation reuses lib/refunds' periodic-
// billing-aware refund resolution (SCRUM-56) rather than re-implementing it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWithMocks, makeRes } = require('./helpers/loadWithMocks');

const tutorCaller = { id: 'tutor-1', role: 'tutor', email: 'tutor@example.com' };
const otherTutorCaller = { id: 'tutor-2', role: 'tutor', email: 'other@example.com' };

const PAST = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const FUTURE = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
const FUTURE_END = new Date(Date.now() + 24 * 3600 * 1000 + 55 * 60 * 1000).toISOString();

function dbWithBooking(booking) {
  return {
    dbGet: async (p) => {
      if (p.startsWith('/bookings?id=eq.')) return [booking];
      // Caller's own profile — 'tutor-1' really is Azeem Omar-Mufti;
      // any other caller id (e.g. 'tutor-2') is a different tutor entirely,
      // so the ownership check on booking.tutor_name correctly fails.
      if (p.startsWith('/profiles?id=eq.tutor-1')) return [{ tutor_name: 'Azeem Omar-Mufti' }];
      if (p.startsWith('/profiles?id=eq.')) return [{ tutor_name: 'Someone Else' }];
      if (p.startsWith('/billing_batches?id=eq.')) return [{ id: 'batch-1', stripe_payment_intent_id: 'pi_batch' }];
      return [];
    },
  };
}

// ── self-cancel-booking ─────────────────────────────────────────────────

test('self-cancel-booking requires authentication', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async (req, res) => { res.status(401).json({ error: 'Unauthorized' }); return null; } },
  });
  const res = makeRes();
  await handler({ method: 'POST', query: { resource: 'self-cancel-booking' }, body: { bookingId: '11111111-1111-1111-1111-111111111111' } }, res);
  assert.equal(res.statusCode, 401);
});

test('self-cancel-booking rejects a tutor who does not own the booking', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => otherTutorCaller },
    db: dbWithBooking({ id: 'b1', tutor_name: 'Azeem Omar-Mufti', status: 'confirmed', start_time: FUTURE, payment_status: 'unbilled' }),
  });
  const res = makeRes();
  await handler({ method: 'POST', query: { resource: 'self-cancel-booking' }, body: { bookingId: '11111111-1111-1111-1111-111111111111' } }, res);
  assert.equal(res.statusCode, 403);
});

test('self-cancel-booking rejects an already-cancelled booking', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: dbWithBooking({ id: 'b1', tutor_name: 'Azeem Omar-Mufti', status: 'cancelled', start_time: FUTURE, payment_status: 'unbilled' }),
  });
  const res = makeRes();
  await handler({ method: 'POST', query: { resource: 'self-cancel-booking' }, body: { bookingId: '11111111-1111-1111-1111-111111111111' } }, res);
  assert.equal(res.statusCode, 409);
});

test('self-cancel-booking rejects a lesson that has already happened', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: dbWithBooking({ id: 'b1', tutor_name: 'Azeem Omar-Mufti', status: 'confirmed', start_time: PAST, payment_status: 'unbilled' }),
  });
  const res = makeRes();
  await handler({ method: 'POST', query: { resource: 'self-cancel-booking' }, body: { bookingId: '11111111-1111-1111-1111-111111111111' } }, res);
  assert.equal(res.statusCode, 409);
});

test('self-cancel-booking cancels an unpaid lesson with no refund attempt', async () => {
  const patches = [];
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: {
      ...dbWithBooking({ id: 'b1', tutor_name: 'Azeem Omar-Mufti', status: 'confirmed', start_time: FUTURE, payment_status: 'unbilled', fee_pence: 4000 }),
      supabaseRequest: async (p, opts) => { patches.push({ p, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({}) }; },
    },
  });
  const res = makeRes();
  await handler({ method: 'POST', query: { resource: 'self-cancel-booking' }, body: { bookingId: '11111111-1111-1111-1111-111111111111' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.refunded, false);
  assert.equal(patches[0].body.status, 'cancelled');
  assert.equal(patches[0].body.payment_status, undefined);
});

test('self-cancel-booking refunds a batch-billed paid lesson and resets payment_status', async () => {
  const patches = [];
  let refundedIntentId, refundedAmount;
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => tutorCaller },
    payments: { createRefund: async ({ paymentIntentId, amount }) => { refundedIntentId = paymentIntentId; refundedAmount = amount; return { id: 're_1' }; } },
    db: {
      ...dbWithBooking({ id: 'b1', tutor_name: 'Azeem Omar-Mufti', status: 'confirmed', start_time: FUTURE, payment_status: 'paid', billing_batch_id: 'batch-1', fee_pence: 4000 }),
      supabaseRequest: async (p, opts) => { patches.push({ p, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({}) }; },
    },
  });
  const res = makeRes();
  await handler({ method: 'POST', query: { resource: 'self-cancel-booking' }, body: { bookingId: '11111111-1111-1111-1111-111111111111' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.refunded, true);
  assert.equal(refundedIntentId, 'pi_batch');
  assert.equal(refundedAmount, 4000);
  assert.equal(patches[0].body.payment_status, 'refunded');
});

// ── self-reschedule-booking ─────────────────────────────────────────────

test('self-reschedule-booking rejects a tutor who does not own the booking', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => otherTutorCaller },
    db: dbWithBooking({ id: 'b1', tutor_name: 'Azeem Omar-Mufti', status: 'confirmed', start_time: FUTURE }),
  });
  const res = makeRes();
  await handler({ method: 'POST', query: { resource: 'self-reschedule-booking' }, body: { bookingId: '11111111-1111-1111-1111-111111111111', newStartTime: FUTURE } }, res);
  assert.equal(res.statusCode, 403);
});

test('self-reschedule-booking shifts end_time by the same delta as start_time', async () => {
  const patches = [];
  const newStart = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: {
      ...dbWithBooking({ id: 'b1', tutor_name: 'Azeem Omar-Mufti', status: 'confirmed', start_time: FUTURE, end_time: FUTURE_END }),
      supabaseRequest: async (p, opts) => { patches.push({ p, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({}) }; },
    },
  });
  const res = makeRes();
  await handler({ method: 'POST', query: { resource: 'self-reschedule-booking' }, body: { bookingId: '11111111-1111-1111-1111-111111111111', newStartTime: newStart } }, res);
  assert.equal(res.statusCode, 200);
  const patchedBody = patches.find(p => p.p.startsWith('/bookings?id=eq.')).body;
  assert.equal(patchedBody.start_time, new Date(newStart).toISOString());
  const deltaMs = new Date(patchedBody.end_time) - new Date(patchedBody.start_time);
  assert.equal(deltaMs, 55 * 60 * 1000, 'lesson duration must stay 55 minutes after moving');
});

test('self-reschedule-booking returns a friendly 409 on tutor double-booking', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: {
      ...dbWithBooking({ id: 'b1', tutor_name: 'Azeem Omar-Mufti', status: 'confirmed', start_time: FUTURE, end_time: FUTURE_END }),
      supabaseRequest: async () => { throw new Error('conflicting key value violates exclusion constraint "bookings_no_tutor_overlap"'); },
    },
  });
  const res = makeRes();
  await handler({ method: 'POST', query: { resource: 'self-reschedule-booking' }, body: { bookingId: '11111111-1111-1111-1111-111111111111', newStartTime: FUTURE } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.conflict, true);
});

test('self-reschedule-booking rejects a lesson that has already happened', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: dbWithBooking({ id: 'b1', tutor_name: 'Azeem Omar-Mufti', status: 'confirmed', start_time: PAST }),
  });
  const res = makeRes();
  await handler({ method: 'POST', query: { resource: 'self-reschedule-booking' }, body: { bookingId: '11111111-1111-1111-1111-111111111111', newStartTime: FUTURE } }, res);
  assert.equal(res.statusCode, 409);
});
