// lib/refunds.js — SCRUM-56: refunding a periodic-billing booking must
// resolve the PaymentIntent via billing_batches, not just the booking's
// own (usually-empty) stripe_payment_intent_id.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const backendRoot = path.join(__dirname, '..');

function loadRefundBooking({ dbGet, createRefund } = {}) {
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  const dbPath = require.resolve(path.join(backendRoot, 'lib/db.js'));
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: { dbGet: dbGet || (async () => []) },
  };
  const paymentsPath = require.resolve(path.join(backendRoot, 'lib/payments/index.js'));
  require.cache[paymentsPath] = {
    id: paymentsPath, filename: paymentsPath, loaded: true,
    exports: { getPaymentService: () => ({ createRefund: createRefund || (async () => ({ id: 're_1' })) }) },
  };
  return require(path.join(backendRoot, 'lib/refunds.js')).refundBooking;
}

test('refundBooking skips anything not paid', async () => {
  const refundBooking = loadRefundBooking();
  const result = await refundBooking({ id: 'b1', payment_status: 'unbilled' });
  assert.deepEqual(result, { refunded: false, reason: 'not_paid' });
});

test('refundBooking uses the booking\'s own PaymentIntent when set (ad-hoc checkout path)', async () => {
  let refundedIntentId;
  const refundBooking = loadRefundBooking({
    createRefund: async ({ paymentIntentId, amount }) => { refundedIntentId = paymentIntentId; return { id: 're_direct', amount }; },
  });
  const result = await refundBooking({ id: 'b1', payment_status: 'paid', stripe_payment_intent_id: 'pi_direct', fee_pence: 4000 });
  assert.equal(refundedIntentId, 'pi_direct');
  assert.equal(result.refunded, true);
  assert.equal(result.refundId, 're_direct');
  assert.equal(result.amountPence, 4000);
});

test('refundBooking falls back to the billing_batches PaymentIntent when the booking has none', async () => {
  let refundedIntentId, refundedAmount;
  const refundBooking = loadRefundBooking({
    dbGet: async (path) => {
      assert.match(path, /\/billing_batches\?id=eq\.batch-1/);
      return [{ id: 'batch-1', stripe_payment_intent_id: 'pi_batch', total_pence: 12000 }];
    },
    createRefund: async ({ paymentIntentId, amount }) => { refundedIntentId = paymentIntentId; refundedAmount = amount; return { id: 're_batch' }; },
  });
  const result = await refundBooking({ id: 'b1', payment_status: 'paid', stripe_payment_intent_id: null, billing_batch_id: 'batch-1', fee_pence: 4000 });
  assert.equal(refundedIntentId, 'pi_batch');
  // Full refund of just this booking's own fee, not the whole batch total.
  assert.equal(refundedAmount, 4000);
  assert.equal(result.refunded, true);
  assert.equal(result.refundId, 're_batch');
});

test('refundBooking reports no_payment_intent when neither the booking nor its batch has one', async () => {
  const refundBooking = loadRefundBooking({
    dbGet: async () => [{ id: 'batch-1', stripe_payment_intent_id: null }],
  });
  const result = await refundBooking({ id: 'b1', payment_status: 'paid', billing_batch_id: 'batch-1' });
  assert.deepEqual(result, { refunded: false, reason: 'no_payment_intent' });
});
