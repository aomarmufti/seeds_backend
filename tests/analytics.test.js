const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWithMocks, makeRes } = require('./helpers/loadWithMocks');

test('reschedule-booking succeeds when no conflict', async () => {
  const handler = loadWithMocks('api/analytics.js', {
    db: { supabaseRequest: async () => ({ ok: true, json: async () => ({}) }) },
  });
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'reschedule-booking', bookingId: 'b1', newStartTime: new Date().toISOString() } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
});

test('reschedule-booking returns a friendly 409 on tutor overlap', async () => {
  const handler = loadWithMocks('api/analytics.js', {
    db: {
      supabaseRequest: async () => ({
        ok: false,
        json: async () => ({ code: '23P01', message: 'conflicting key value violates exclusion constraint "bookings_no_tutor_overlap"' }),
      }),
    },
  });
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'reschedule-booking', bookingId: 'b1', newStartTime: new Date().toISOString() } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.conflict, true);
});

test('reschedule-booking requires bookingId and newStartTime', async () => {
  const handler = loadWithMocks('api/analytics.js');
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'reschedule-booking' } }, res);
  assert.equal(res.statusCode, 400);
});

test('cancel-booking marks the booking cancelled without a refund when unpaid', async () => {
  const handler = loadWithMocks('api/analytics.js', {
    db: {
      dbGet: async () => [{ id: 'b1', stripe_payment_intent_id: null }],
      supabaseRequest: async () => ({ ok: true, json: async () => ({}) }),
    },
  });
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'cancel-booking', bookingId: 'b1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.refunded, false);
});

test('unknown analytics POST action returns 400', async () => {
  const handler = loadWithMocks('api/analytics.js');
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'not-a-real-action' } }, res);
  assert.equal(res.statusCode, 400);
});

test('resource=my-bookings returns only the caller\'s own bookings, scoped by their email', async () => {
  const handler = loadWithMocks('api/analytics.js', {
    auth: {
      requireAuth: async () => ({ id: 'parent-1', role: 'student', email: 'parent@example.com' }),
    },
    db: {
      dbGet: async (path) => {
        if (path.startsWith('/students')) return [{ id: 's1', stripe_customer_id: 'cus_1' }];
        return [{
          id: 'b1', subject: 'Maths', tutor_name: 'Azeem', lesson_type: 'gcse',
          start_time: '2026-08-01T10:00:00Z', fee_pence: 4000, status: 'confirmed',
          stripe_payment_intent_id: 'pi_1', payment_link: null,
        }];
      },
    },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'my-bookings' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.recentBookings.length, 1);
  assert.equal(res.body.recentBookings[0].parentEmail, 'parent@example.com');
  assert.equal(res.body.recentBookings[0].stripeCustomerId, 'cus_1');
});

test('resource=my-bookings requires an authenticated caller', async () => {
  const handler = loadWithMocks('api/analytics.js', {
    auth: { requireAuth: async (req, res) => { res.status(401).json({ error: 'Unauthorized' }); return null; } },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'my-bookings' } }, res);
  assert.equal(res.statusCode, 401);
});

test('resource=my-bookings returns an empty list for a caller with no student record', async () => {
  const handler = loadWithMocks('api/analytics.js', {
    auth: { requireAuth: async () => ({ id: 'parent-2', role: 'student', email: 'nobody@example.com' }) },
    db: { dbGet: async () => [] },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'my-bookings' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.recentBookings, []);
});
