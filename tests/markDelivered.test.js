// SCRUM-88: attestation. Nothing is billed to a family or paid to a tutor
// until somebody states what actually happened in the lesson, and this is
// the endpoint where that statement is made.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWithMocks, makeRes } = require('./helpers/loadWithMocks');

const tutorCaller = { id: 'tutor-1', role: 'tutor', email: 'tutor@example.com' };
const otherTutorCaller = { id: 'tutor-2', role: 'tutor', email: 'other@example.com' };
const adminCaller = { id: 'admin-1', role: 'admin', email: 'admin@example.com' };

const PAST_START = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
const PAST_END = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const FUTURE_START = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
const FUTURE_END = new Date(Date.now() + 25 * 3600 * 1000).toISOString();

function baseBooking(over = {}) {
  return {
    id: 'booking-1', tutor_name: 'Azeem Omar-Mufti', student_id: 'student-1',
    status: 'confirmed', fee_pence: 4000, payment_status: 'unbilled',
    start_time: PAST_START, end_time: PAST_END,
    delivery_status: null, paid_out_at: null, ...over,
  };
}

function load(booking, caller) {
  const patches = [];
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => caller, getAuthedUser: async () => caller },
    db: {
      dbGet: async (p) => {
        if (p.startsWith('/bookings?id=eq.')) return [booking];
        if (p.startsWith('/profiles?id=eq.tutor-1')) return [{ tutor_name: 'Azeem Omar-Mufti' }];
        if (p.startsWith('/profiles?id=eq.')) return [{ tutor_name: 'Someone Else' }];
        return [];
      },
      supabaseRequest: async (p, opts) => {
        if (opts?.method === 'PATCH' && p.startsWith('/bookings?')) {
          patches.push(JSON.parse(opts.body));
        }
        return { ok: true, json: async () => [{ ...booking, ...(opts?.body ? JSON.parse(opts.body) : {}) }] };
      },
    },
  });
  return { handler, patches };
}

const call = (handler, body) =>
  handler({ method: 'POST', query: { resource: 'mark-delivered' }, body }, makeRes());

test('a tutor can mark their own finished lesson delivered', async () => {
  const { handler, patches } = load(baseBooking(), tutorCaller);
  const res = makeRes();
  await handler({ method: 'POST', query: { resource: 'mark-delivered' }, body: { bookingId: 'booking-1', outcome: 'delivered' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(patches[0].delivery_status, 'delivered');
  assert.ok(patches[0].delivered_at, 'must record when the attestation was made');
  assert.equal(patches[0].delivery_marked_by, 'tutor@example.com', 'must record who said so');
  assert.equal(patches[0].status, 'completed');
});

test('a no-show is attested and still concludes the lesson', async () => {
  const { handler, patches } = load(baseBooking(), tutorCaller);
  const res = makeRes();
  await handler({ method: 'POST', query: { resource: 'mark-delivered' }, body: { bookingId: 'booking-1', outcome: 'no_show', note: 'Waited 20 minutes' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(patches[0].delivery_status, 'no_show');
  assert.equal(patches[0].delivery_note, 'Waited 20 minutes');
  assert.equal(patches[0].status, 'completed');
});

test('a lesson cannot be marked delivered before it has finished', async () => {
  // Otherwise the endpoint just reintroduces the bug it exists to fix, one
  // booking at a time: a future lesson would become billable early.
  const { handler, patches } = load(baseBooking({ start_time: FUTURE_START, end_time: FUTURE_END }), tutorCaller);
  const res = await call(handler, { bookingId: 'booking-1', outcome: 'delivered' });
  assert.equal(res.statusCode, 409);
  assert.equal(patches.length, 0, 'nothing may be written');
});

test('a tutor cannot attest another tutor\'s lesson', async () => {
  const { handler, patches } = load(baseBooking(), otherTutorCaller);
  const res = await call(handler, { bookingId: 'booking-1', outcome: 'delivered' });
  assert.equal(res.statusCode, 403);
  assert.equal(patches.length, 0);
});

test('a tutor cannot silently re-mark a lesson they already attested', async () => {
  const { handler, patches } = load(baseBooking({ delivery_status: 'no_show' }), tutorCaller);
  const res = await call(handler, { bookingId: 'booking-1', outcome: 'delivered' });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /admin/i, 'should point the tutor at an admin rather than just refusing');
  assert.equal(patches.length, 0);
});

test('an admin can correct an attestation a tutor already made', async () => {
  const { handler, patches } = load(baseBooking({ delivery_status: 'no_show' }), adminCaller);
  const res = await call(handler, { bookingId: 'booking-1', outcome: 'delivered' });
  assert.equal(res.statusCode, 200);
  assert.equal(patches[0].delivery_status, 'delivered');
});

test('nobody can re-mark a lesson that has already been paid out', async () => {
  // By that point the outcome is settled history — changing it would
  // desynchronise the tutor's recorded earnings from what they were sent.
  const { handler, patches } = load(
    baseBooking({ delivery_status: 'delivered', paid_out_at: PAST_END }), adminCaller);
  const res = await call(handler, { bookingId: 'booking-1', outcome: 'no_show' });
  assert.equal(res.statusCode, 409);
  assert.equal(patches.length, 0);
});

test('late_cancelled cannot be asserted directly through this endpoint', async () => {
  // It is only ever written by the cancellation path, which is the one place
  // that can measure notice against the clock. Otherwise "they cancelled
  // late" becomes a claim anyone can make after the fact.
  const { handler, patches } = load(baseBooking(), tutorCaller);
  const res = await call(handler, { bookingId: 'booking-1', outcome: 'late_cancelled' });
  assert.equal(res.statusCode, 400);
  assert.equal(patches.length, 0);
});

test('an unrecognised outcome is rejected', async () => {
  const { handler, patches } = load(baseBooking(), tutorCaller);
  const res = await call(handler, { bookingId: 'booking-1', outcome: 'went_fine_i_think' });
  assert.equal(res.statusCode, 400);
  assert.equal(patches.length, 0);
});

test('a lesson that was never confirmed cannot be attested', async () => {
  const { handler, patches } = load(baseBooking({ status: 'requested' }), tutorCaller);
  const res = await call(handler, { bookingId: 'booking-1', outcome: 'delivered' });
  assert.equal(res.statusCode, 409);
  assert.equal(patches.length, 0);
});

test('waiving a lesson records no delivered_at, since nothing was delivered', async () => {
  const { handler, patches } = load(baseBooking(), tutorCaller);
  const res = await call(handler, { bookingId: 'booking-1', outcome: 'waived' });
  assert.equal(res.statusCode, 200);
  assert.equal(patches[0].delivery_status, 'waived');
  assert.equal(patches[0].delivered_at, null);
  assert.equal(patches[0].status, undefined, 'a waived lesson keeps whatever status it had');
});

test('an over-long note is rejected rather than truncated', async () => {
  const { handler, patches } = load(baseBooking(), tutorCaller);
  const res = await call(handler, { bookingId: 'booking-1', outcome: 'delivered', note: 'x'.repeat(501) });
  assert.equal(res.statusCode, 400);
  assert.equal(patches.length, 0);
});

test('a lesson cut short by the student is still billed in full', async () => {
  // The tutor held and delivered the slot; the student leaving early is not
  // the tutor's loss to absorb.
  const { handler, patches } = load(baseBooking(), tutorCaller);
  const res = await call(handler, { bookingId: 'booking-1', outcome: 'partial' });
  assert.equal(res.statusCode, 200);
  assert.equal(patches[0].delivery_status, 'partial');
  assert.equal(patches[0].status, 'completed');
  assert.ok(patches[0].delivered_at, 'the slot was consumed, so it has a delivery time');
});

test('a mutually agreed cancellation bills nobody and reads as cancelled', async () => {
  const { handler, patches } = load(baseBooking(), tutorCaller);
  const res = await call(handler, { bookingId: 'booking-1', outcome: 'cancelled_mutual' });
  assert.equal(res.statusCode, 200);
  assert.equal(patches[0].delivery_status, 'cancelled_mutual');
  assert.equal(patches[0].status, 'cancelled');
  assert.equal(patches[0].delivered_at, null, 'nothing was delivered, so no delivery time');
});

test('a tutor cancelling their own lesson bills nobody', async () => {
  const { handler, patches } = load(baseBooking(), tutorCaller);
  const res = await call(handler, { bookingId: 'booking-1', outcome: 'tutor_cancelled' });
  assert.equal(res.statusCode, 200);
  assert.equal(patches[0].delivery_status, 'tutor_cancelled');
  assert.equal(patches[0].status, 'cancelled');
  assert.equal(patches[0].delivered_at, null);
});

test('every outcome the tutor can pick is either billable or explicitly not', async () => {
  // Guards the seam between this endpoint's accepted outcomes and the set the
  // billing/payout sweeps filter on. An outcome that exists here but appears
  // in neither list would be silently unbillable forever.
  const { BILLABLE_OUTCOMES } = require('../lib/cancellationPolicy');
  const SETTABLE = ['delivered', 'partial', 'no_show', 'cancelled_mutual', 'tutor_cancelled', 'waived'];
  const NOT_BILLABLE = ['cancelled_mutual', 'tutor_cancelled', 'waived'];
  for (const o of SETTABLE) {
    assert.equal(
      BILLABLE_OUTCOMES.includes(o), !NOT_BILLABLE.includes(o),
      `${o} must be clearly on one side of the billing line`
    );
  }
  // late_cancelled isn't settable here but must still bill — the family gave
  // less than 18 hours' notice and the tutor held the slot.
  assert.ok(BILLABLE_OUTCOMES.includes('late_cancelled'));
});

test('awaiting-delivery lists only finished, unattested lessons for that tutor', async () => {
  let queried;
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => tutorCaller, getAuthedUser: async () => tutorCaller },
    db: {
      dbGet: async (p) => {
        if (p.startsWith('/profiles?id=eq.tutor-1')) return [{ tutor_name: 'Azeem Omar-Mufti' }];
        if (p.startsWith('/bookings?')) { queried = p; return []; }
        return [];
      },
    },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'awaiting-delivery', tutorName: 'Azeem Omar-Mufti' } }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(queried.includes('delivery_status=is.null'), 'only lessons nobody has answered for');
  assert.ok(queried.includes('end_time=lte.'), 'only lessons that have actually finished');
  assert.ok(queried.includes('status=neq.requested'), 'a never-confirmed request is not awaiting attestation');
});

test('a tutor cannot list another tutor\'s awaiting-delivery queue', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => otherTutorCaller, getAuthedUser: async () => otherTutorCaller },
    db: { dbGet: async (p) => (p.startsWith('/profiles?id=eq.') ? [{ tutor_name: 'Someone Else' }] : []) },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'awaiting-delivery', tutorName: 'Azeem Omar-Mufti' } }, res);
  assert.equal(res.statusCode, 403);
});
