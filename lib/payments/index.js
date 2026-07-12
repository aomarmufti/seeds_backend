// lib/payments/index.js
// Single place that decides which PaymentService implementation is
// live. Swapping providers (or supporting more than one) means
// changing this file only — application code always calls
// getPaymentService() and never requires a concrete provider directly.

const { StripePaymentService } = require('./StripePaymentService');

let instance = null;

function getPaymentService() {
  if (!instance) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not configured');
    }
    instance = new StripePaymentService({
      secretKey: process.env.STRIPE_SECRET_KEY,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    });
  }
  return instance;
}

// Test-only: allows tests to inject a mock PaymentService instead of
// constructing a real Stripe client.
function _setPaymentServiceForTesting(mock) {
  instance = mock;
}

module.exports = { getPaymentService, _setPaymentServiceForTesting };
