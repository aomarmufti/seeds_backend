// lib/payments/StripePaymentService.js
// Stripe implementation of PaymentService. This is the ONLY file that
// should require('stripe') for customer-facing payments (checkout,
// cards, refunds, subscriptions, invoices) — everything else goes
// through the interface in PaymentService.js so swapping providers
// later doesn't touch application code.
//
// Tutor payouts (Stripe Connect accounts, transfers) are a separate
// domain from customer payments and are intentionally out of scope
// here — api/payouts.js continues to use the Stripe SDK directly for
// that, since "who gets paid" and "who pays us" aren't interchangeable
// across payment providers the way checkout/refunds/subscriptions are.

const { PaymentService } = require('./PaymentService');

class StripePaymentService extends PaymentService {
  constructor({ secretKey, webhookSecret }) {
    super();
    if (!secretKey) throw new Error('StripePaymentService requires a secret key');
    this.stripe = require('stripe')(secretKey);
    this.webhookSecret = webhookSecret;
  }

  async createCustomer({ email, name, phone, metadata }) {
    if (!email) throw new Error('email is required');
    // Get-or-create by email — avoids duplicate Stripe customers for the
    // same parent across repeat bookings (matches this codebase's
    // existing convention in create-setup-intent.js).
    const existing = await this.stripe.customers.list({ email, limit: 1 });
    if (existing.data.length) return existing.data[0];
    return this.stripe.customers.create({ email, name, phone, metadata });
  }

  async createCheckoutSession({
    customerId, customerEmail, amount, currency = 'gbp', description,
    successUrl, cancelUrl, metadata, mode = 'payment',
  }) {
    if (!amount || amount < 0) throw new Error('amount must be a positive integer (pence)');
    if (!successUrl || !cancelUrl) throw new Error('successUrl and cancelUrl are required');

    const params = {
      mode,
      // Omitting payment_method_types lets Stripe Checkout automatically
      // offer Apple Pay / Google Pay / card based on the buyer's browser
      // and the domain verification configured in the Stripe Dashboard —
      // there's no separate "enable Apple Pay" API call to make here.
      line_items: [{
        price_data: {
          currency,
          product_data: { name: description || 'Seeds Tuition lesson' },
          unit_amount: amount,
        },
        quantity: 1,
      }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: metadata || {},
    };
    if (customerId) params.customer = customerId;
    else if (customerEmail) params.customer_email = customerEmail;

    return this.stripe.checkout.sessions.create(params);
  }

  async retrieveCheckoutSession(sessionId) {
    return this.stripe.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent'] });
  }

  async createPaymentIntent({ amount, currency = 'gbp', customerId, paymentMethodId, description, receiptEmail, metadata, confirm, offSession }) {
    return this.stripe.paymentIntents.create({
      amount, currency,
      customer: customerId,
      payment_method: paymentMethodId,
      confirm: !!confirm,
      off_session: !!offSession,
      description,
      receipt_email: receiptEmail,
      metadata: metadata || {},
    });
  }

  async retrievePaymentIntent(paymentIntentId) {
    return this.stripe.paymentIntents.retrieve(paymentIntentId);
  }

  async createSetupIntent({ customerId, metadata }) {
    return this.stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
      usage: 'off_session',
      metadata: metadata || {},
    });
  }

  async listPaymentMethods(customerId) {
    const result = await this.stripe.paymentMethods.list({ customer: customerId, type: 'card' });
    return result.data;
  }

  async detachPaymentMethod(paymentMethodId) {
    return this.stripe.paymentMethods.detach(paymentMethodId);
  }

  async createCustomerPortalSession({ customerId, returnUrl }) {
    return this.stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
  }

  async createRefund({ paymentIntentId, amount, reason }) {
    const params = { payment_intent: paymentIntentId };
    if (amount) params.amount = amount;
    if (reason) params.reason = reason;
    return this.stripe.refunds.create(params);
  }

  async createSubscription({ customerId, priceId, metadata }) {
    return this.stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      metadata: metadata || {},
    });
  }

  async cancelSubscription(subscriptionId) {
    return this.stripe.subscriptions.cancel(subscriptionId);
  }

  async listInvoices(customerId) {
    const result = await this.stripe.invoices.list({ customer: customerId, limit: 100 });
    return result.data;
  }

  constructWebhookEvent(rawBody, signature) {
    if (!this.webhookSecret) throw new Error('Stripe webhook secret not configured');
    return this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
  }
}

module.exports = { StripePaymentService };
