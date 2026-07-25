// lib/refunds.js
// Shared refund resolution for cancel-booking/refund-booking/bulk-cancel.
//
// Under periodic billing (SCRUM-56), a paid booking's PaymentIntent lives
// on its billing_batches row, not on the booking itself — the booking only
// gets stripe_payment_intent_id set for the older ad-hoc-checkout path.
// This resolves whichever one applies and issues a full refund of the
// booking's own fee (policy: always full refund, even if Stripe's
// processing fee isn't recovered — never a partial/prorated refund).
const { dbGet } = require('./db');
const { getPaymentService } = require('./payments');

async function refundBooking(booking, { reason } = {}) {
  if (booking.payment_status !== 'paid') {
    return { refunded: false, reason: 'not_paid' };
  }

  let paymentIntentId = booking.stripe_payment_intent_id;
  if (!paymentIntentId && booking.billing_batch_id) {
    const batches = await dbGet(`/billing_batches?id=eq.${booking.billing_batch_id}&limit=1`);
    paymentIntentId = batches[0]?.stripe_payment_intent_id;
  }
  if (!paymentIntentId) {
    return { refunded: false, reason: 'no_payment_intent' };
  }

  const payments = getPaymentService();
  const refund = await payments.createRefund({
    paymentIntentId,
    amount: booking.fee_pence,
    reason: reason || 'requested_by_customer',
  });
  return { refunded: true, refundId: refund.id, amountPence: booking.fee_pence };
}

module.exports = { refundBooking };
