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
    exports: {
      requireAdmin: async () => ({ id: 'admin-1', role: 'admin' }),
      requireAuth: async () => ({ id: 'admin-1', role: 'admin' }),
    },
  };
}
// A logged-in, non-admin parent whose own student record owns cus_1 —
// used to exercise billing.js's ownership check on the "happy path".
function mockOwnerAuth() {
  const authPath = require.resolve(path.join(backendRoot, 'lib/auth.js'));
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { requireAuth: async () => ({ id: 'parent-1', email: 'parent@example.com', role: 'student' }) },
  };
  const dbPath = require.resolve(path.join(backendRoot, 'lib/db.js'));
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      // Mirrors a real ownership lookup: only matches when the query is
      // actually filtering on the customer id this fixture owns (cus_1),
      // so tests for a mismatched customerId correctly see no match.
      dbGet: async (queryPath) => queryPath.includes('cus_1')
        ? [{ id: 's1', parent_email: 'parent@example.com', stripe_customer_id: 'cus_1' }]
        : [],
    },
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
  mockOwnerAuth();
  const handler = require(path.join(backendRoot, 'api/billing.js'));
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'payment-methods', customerId: 'cus_1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, [{ id: 'pm_1', brand: 'visa', last4: '4242', expMonth: 8, expYear: 2030 }]);
});

test('GET billing?resource=payment-methods requires a customerId', async () => {
  mockPaymentsModule({});
  mockCors();
  mockAdminAuth();
  const handler = require(path.join(backendRoot, 'api/billing.js'));
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'payment-methods' } }, res);
  assert.equal(res.statusCode, 400);
});

test('GET billing?resource=payment-methods rejects an unauthenticated caller', async () => {
  mockPaymentsModule({});
  mockCors();
  const authPath = require.resolve(path.join(backendRoot, 'lib/auth.js'));
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { requireAuth: async (req, res) => { res.status(401).json({ error: 'Unauthorized' }); return null; } },
  };
  const handler = require(path.join(backendRoot, 'api/billing.js'));
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'payment-methods', customerId: 'cus_1' }, headers: {} }, res);
  assert.equal(res.statusCode, 401);
});

test('GET billing?resource=payment-methods rejects a customerId the caller does not own', async () => {
  mockPaymentsModule({ listPaymentMethods: async () => [{ id: 'pm_1', card: {} }] });
  mockCors();
  mockOwnerAuth(); // owns cus_1, not cus_someone_else
  const handler = require(path.join(backendRoot, 'api/billing.js'));
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'payment-methods', customerId: 'cus_someone_else' } }, res);
  assert.equal(res.statusCode, 403);
});

test('POST billing payment-methods detach removes a saved card', async () => {
  let detached = null;
  mockPaymentsModule({
    listPaymentMethods: async () => [{ id: 'pm_1' }],
    detachPaymentMethod: async (id) => { detached = id; },
  });
  mockCors();
  mockOwnerAuth();
  const handler = require(path.join(backendRoot, 'api/billing.js'));
  const res = makeRes();
  await handler({ method: 'POST', body: { resource: 'payment-methods', action: 'detach', paymentMethodId: 'pm_1', customerId: 'cus_1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(detached, 'pm_1');
});

test('POST billing payment-methods detach rejects a paymentMethodId not on the caller\'s customer', async () => {
  let detached = null;
  mockPaymentsModule({
    listPaymentMethods: async () => [{ id: 'pm_other' }],
    detachPaymentMethod: async (id) => { detached = id; },
  });
  mockCors();
  mockOwnerAuth();
  const handler = require(path.join(backendRoot, 'api/billing.js'));
  const res = makeRes();
  await handler({ method: 'POST', body: { resource: 'payment-methods', action: 'detach', paymentMethodId: 'pm_1', customerId: 'cus_1' } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(detached, null);
});

test('POST billing customer-portal creates a session and returns its url', async () => {
  let captured;
  mockPaymentsModule({ createCustomerPortalSession: async (params) => { captured = params; return { url: 'https://billing.stripe.com/p/session_1' }; } });
  mockCors();
  mockOwnerAuth();
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
  mockAdminAuth();
  const handler = require(path.join(backendRoot, 'api/billing.js'));
  const res = makeRes();
  await handler({ method: 'POST', body: { resource: 'customer-portal' } }, res);
  assert.equal(res.statusCode, 400);
});

test('POST billing rejects an unknown resource', async () => {
  mockPaymentsModule({});
  mockCors();
  mockAdminAuth();
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
