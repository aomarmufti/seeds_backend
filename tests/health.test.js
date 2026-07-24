const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWithMocks, makeRes } = require('./helpers/loadWithMocks');

// SCRUM-46: business health signals reusing existing data (bookings,
// payment failures, pending payouts, webhook activity) rather than a
// separate paid monitoring service.

test('health stats summarizes bookings/payment failures/payouts/webhooks', async () => {
  const handler = loadWithMocks('api/health.js', {
    db: {
      dbGet: async (path) => {
        if (path.startsWith('/bookings?start_time')) return [{ id: 'b1' }, { id: 'b2' }];
        if (path.startsWith('/bookings?status=eq.payment_failed')) return [{ id: 'b3' }];
        if (path.startsWith('/payouts?status=eq.requested')) return [{ amount_pence: 5000 }, { amount_pence: 3000 }];
        if (path.startsWith('/stripe_webhook_events')) return [{ event_id: 'evt_1' }];
        return [];
      },
    },
  });
  const res = makeRes();
  await handler({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.stats.bookingsToday, 2);
  assert.equal(res.body.stats.paymentFailuresLast7Days, 1);
  assert.equal(res.body.stats.pendingPayoutsCount, 2);
  assert.equal(res.body.stats.pendingPayoutsPence, 8000);
  assert.match(res.body.stats.stripeWebhooksReceivedLast7Days, /receiving events/);
});

test('health stats flags no recent webhook activity', async () => {
  const handler = loadWithMocks('api/health.js', {
    db: { dbGet: async () => [] },
  });
  const res = makeRes();
  await handler({}, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.body.stats.stripeWebhooksReceivedLast7Days, /none received/);
});
