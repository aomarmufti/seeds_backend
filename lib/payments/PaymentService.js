// lib/payments/PaymentService.js
// Provider-agnostic payment interface. Application code (api/*.js) must
// call methods on a PaymentService instance obtained from
// lib/payments/index.js — never require('stripe') directly outside of
// StripePaymentService — so a future provider (e.g. GoCardless) can be
// swapped in by adding a new *PaymentService class without touching
// application logic.
//
// All money amounts are integers in the smallest currency unit (pence
// for GBP), matching Stripe's convention, since that's what the rest of
// this codebase already stores (bookings.fee_pence etc).

class PaymentService {
  /** Create (or find) a customer record for a parent/student. */
  async createCustomer(_params) { throw notImplemented('createCustomer'); }

  /** Create a hosted checkout session for a one-off lesson payment. */
  async createCheckoutSession(_params) { throw notImplemented('createCheckoutSession'); }

  /** Retrieve a previously created checkout session. */
  async retrieveCheckoutSession(_sessionId) { throw notImplemented('retrieveCheckoutSession'); }

  /** Create a payment intent directly (used by flows not going through Checkout). */
  async createPaymentIntent(_params) { throw notImplemented('createPaymentIntent'); }

  /** Retrieve a payment intent. */
  async retrievePaymentIntent(_paymentIntentId) { throw notImplemented('retrievePaymentIntent'); }

  /** Create a setup intent so a customer can save a card for later use. */
  async createSetupIntent(_params) { throw notImplemented('createSetupIntent'); }

  /** List a customer's saved payment methods. */
  async listPaymentMethods(_customerId) { throw notImplemented('listPaymentMethods'); }

  /** Detach (remove) a saved payment method. */
  async detachPaymentMethod(_paymentMethodId) { throw notImplemented('detachPaymentMethod'); }

  /** Create a billing/customer portal session (manage cards, view invoices). */
  async createCustomerPortalSession(_params) { throw notImplemented('createCustomerPortalSession'); }

  /** Refund a payment, in full or in part. */
  async createRefund(_params) { throw notImplemented('createRefund'); }

  /** Create a recurring subscription (not currently wired into the booking flow — lessons are one-off — but part of the interface for when it is needed). */
  async createSubscription(_params) { throw notImplemented('createSubscription'); }

  /** Cancel a subscription. */
  async cancelSubscription(_subscriptionId) { throw notImplemented('cancelSubscription'); }

  /** List a customer's invoices. */
  async listInvoices(_customerId) { throw notImplemented('listInvoices'); }

  /** Verify and parse an incoming webhook request body against its signature. */
  constructWebhookEvent(_rawBody, _signature) { throw notImplemented('constructWebhookEvent'); }
}

function notImplemented(method) {
  return new Error(`PaymentService.${method} is not implemented by this provider`);
}

module.exports = { PaymentService };
