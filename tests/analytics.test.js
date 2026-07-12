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
