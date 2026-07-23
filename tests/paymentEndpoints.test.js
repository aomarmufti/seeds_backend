const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const backendRoot = path.join(__dirname, '..');

function mockPaymentsModule(mock) {
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  const p = require.resolve(path.join(backendRoot, 'lib/payments/index.js'));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: { getPaymentService: () => mock } };
}
function mockCors() {
  const p = require.resolve(path.join(backendRoot, 'lib/cors.js'));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: { applyCors: () => false } };
}
function mockAdminAuth() {
  const p = require.resolve(path.join(backendRoot, 'lib/auth.js'));
  require.cache[p] = {
    id: p, filename: p, loaded: true,
    exports: { requireAdmin: async () => ({ id: 'admin-1', role: 'admin' }) },
  };
}
function makeRes() {
  const res = {};
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('GET billing?resource=payment-methods returns a simplified card list', async () => {
  mockPaymentsModule({ listPaymentMethods: async () => [{ id: 'pm_1', card: { brand: 'visa', last4: '4242', exp_month: 8, exp_year: 2030 } }] });
  mockCors();
  const handler = require(path.join(backendRoot, 'api/billing.js'));
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'payment-methods', customerId: 'cus_1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, [{ id: 'pm_1', brand: 'visa', last4: '4242', expMonth: 8, expYear: 2030 }]);
});

test('GET billing?resource=payment-methods requires a customerId', async () => {
  mockPaymentsModule({});
  mockCors();
  const handler = require(path.join(backendRoot, 'api/billing.js'));
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'payment-methods' } }, res);
  assert.equal(res.statusCode, 400);
});

test('POST billing payment-methods detach removes a saved card', async () => {
  let detached = null;
  mockPaymentsModule({ detachPaymentMethod: async (id) => { detached = id; } });
  mockCors();
  const handler = require(path.join(backendRoot, 'api/billing.js'));
  const res = makeRes();
  await handler({ method: 'POST', body: { resource: 'payment-methods', action: 'detach', paymentMethodId: 'pm_1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(detached, 'pm_1');
});

test('POST billing customer-portal creates a session and returns its url', async () => {
  let captured;
  mockPaymentsModule({ createCustomerPortalSession: async (params) => { captured = params; return { url: 'https://billing.stripe.com/p/session_1' }; } });
  mockCors();
  const handler = require(path.join(backendRoot, 'api/billing.js'));
  const res = makeRes();
  await handler({ method: 'POST', body: { resource: 'customer-portal', customerId: 'cus_1', returnUrl: 'https://example.com/account' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.url, 'https://billing.stripe.com/p/session_1');
  assert.equal(captured.customerId, 'cus_1');
});

test('POST billing customer-portal requires a customerId', async () => {
  mockPaymentsModule({});
  mockCors();
  const handler = require(path.join(backendRoot, 'api/billing.js'));
  const res = makeRes();
  await handler({ method: 'POST', body: { resource: 'customer-portal' } }, res);
  assert.equal(res.statusCode, 400);
});

test('POST billing rejects an unknown resource', async () => {
  mockPaymentsModule({});
  mockCors();
  const handler = require(path.join(backendRoot, 'api/billing.js'));
  const res = makeRes();
  await handler({ method: 'POST', body: { resource: 'not-a-real-resource' } }, res);
  assert.equal(res.statusCode, 400);
});

test('analytics refund-booking issues a refund for a paid booking', async () => {
  mockPaymentsModule({ createRefund: async (params) => ({ id: 're_1', amount: params.amount || 4000 }) });
  mockCors();
  mockAdminAuth();
  const dbPath = require.resolve(path.join(backendRoot, 'lib/db.js'));
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: { dbGet: async () => [{ id: 'b1', stripe_payment_intent_id: 'pi_1' }] },
  };
  const handler = require(path.join(backendRoot, 'api/analytics.js'));
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'refund-booking', bookingId: 'b1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.refundId, 're_1');
});

test('analytics refund-booking rejects a booking with no payment', async () => {
  mockPaymentsModule({});
  mockCors();
  mockAdminAuth();
  const dbPath = require.resolve(path.join(backendRoot, 'lib/db.js'));
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: { dbGet: async () => [{ id: 'b2', stripe_payment_intent_id: null }] },
  };
  const handler = require(path.join(backendRoot, 'api/analytics.js'));
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'refund-booking', bookingId: 'b2' } }, res);
  assert.equal(res.statusCode, 400);
});
