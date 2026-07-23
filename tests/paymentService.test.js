const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const backendRoot = path.join(__dirname, '..');

function loadStripePaymentService(stripeMock) {
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  const stripePath = require.resolve('stripe');
  require.cache[stripePath] = { id: stripePath, filename: stripePath, loaded: true, exports: () => stripeMock };
  const { StripePaymentService } = require(path.join(backendRoot, 'lib/payments/StripePaymentService'));
  return new StripePaymentService({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x' });
}

test('createCustomer reuses an existing Stripe customer found by email', async () => {
  let createCalled = false;
  const svc = loadStripePaymentService({
    customers: {
      list: async ({ email }) => (email === 'p@example.com' ? { data: [{ id: 'cus_existing' }] } : { data: [] }),
      create: async () => { createCalled = true; return { id: 'cus_new' }; },
    },
  });
  const customer = await svc.createCustomer({ email: 'p@example.com', name: 'Parent' });
  assert.equal(customer.id, 'cus_existing');
  assert.equal(createCalled, false);
});

test('createCustomer creates a new customer when none exists', async () => {
  const svc = loadStripePaymentService({
    customers: {
      list: async () => ({ data: [] }),
      create: async (params) => ({ id: 'cus_new', ...params }),
    },
  });
  const customer = await svc.createCustomer({ email: 'new@example.com', name: 'New Parent' });
  assert.equal(customer.id, 'cus_new');
});

test('createCheckoutSession builds a valid one-off payment session', async () => {
  let captured;
  const svc = loadStripePaymentService({
    checkout: { sessions: { create: async (params) => { captured = params; return { id: 'cs_1', url: 'https://checkout.stripe.com/cs_1' }; } } },
  });
  const session = await svc.createCheckoutSession({
    customerEmail: 'p@example.com', amount: 4000, description: 'GCSE Maths lesson',
    successUrl: 'https://example.com/success', cancelUrl: 'https://example.com/cancel',
    metadata: { bookingId: 'b1' },
  });
  assert.equal(session.id, 'cs_1');
  assert.equal(captured.customer_email, 'p@example.com');
  assert.equal(captured.line_items[0].price_data.unit_amount, 4000);
  assert.equal(captured.metadata.bookingId, 'b1');
  assert.equal(captured.mode, 'payment');
});

test('createCheckoutSession rejects a missing amount', async () => {
  const svc = loadStripePaymentService({});
  await assert.rejects(() => svc.createCheckoutSession({ successUrl: 'a', cancelUrl: 'b' }));
});

test('createSetupIntent requests off_session card usage', async () => {
  let captured;
  const svc = loadStripePaymentService({
    setupIntents: { create: async (params) => { captured = params; return { client_secret: 'seti_secret' }; } },
  });
  await svc.createSetupIntent({ customerId: 'cus_1' });
  assert.equal(captured.customer, 'cus_1');
  assert.equal(captured.usage, 'off_session');
});

test('listPaymentMethods returns only the data array', async () => {
  const svc = loadStripePaymentService({
    paymentMethods: { list: async () => ({ data: [{ id: 'pm_1' }, { id: 'pm_2' }] }) },
  });
  const methods = await svc.listPaymentMethods('cus_1');
  assert.deepEqual(methods.map(m => m.id), ['pm_1', 'pm_2']);
});

test('createCustomerPortalSession passes through customer and return_url', async () => {
  let captured;
  const svc = loadStripePaymentService({
    billingPortal: { sessions: { create: async (params) => { captured = params; return { url: 'https://billing.stripe.com/x' }; } } },
  });
  await svc.createCustomerPortalSession({ customerId: 'cus_1', returnUrl: 'https://example.com/account' });
  assert.equal(captured.customer, 'cus_1');
  assert.equal(captured.return_url, 'https://example.com/account');
});

test('createRefund supports partial refunds', async () => {
  let captured;
  const svc = loadStripePaymentService({
    refunds: { create: async (params) => { captured = params; return { id: 're_1' }; } },
  });
  await svc.createRefund({ paymentIntentId: 'pi_1', amount: 1000, reason: 'requested_by_customer' });
  assert.equal(captured.payment_intent, 'pi_1');
  assert.equal(captured.amount, 1000);
});

test('constructWebhookEvent delegates to stripe.webhooks.constructEvent with the configured secret', () => {
  let captured;
  const svc = loadStripePaymentService({
    webhooks: { constructEvent: (body, sig, secret) => { captured = { body, sig, secret }; return { id: 'evt_1' }; } },
  });
  const event = svc.constructWebhookEvent('raw-body', 'sig-header');
  assert.equal(event.id, 'evt_1');
  assert.equal(captured.secret, 'whsec_x');
});

test('base PaymentService throws not-implemented for every method by default', async () => {
  const { PaymentService } = require(path.join(backendRoot, 'lib/payments/PaymentService'));
  const base = new PaymentService();
  await assert.rejects(() => base.createCheckoutSession({}), /not implemented/);
  await assert.rejects(() => base.createRefund({}), /not implemented/);
});
