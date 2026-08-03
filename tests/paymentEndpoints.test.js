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
//
// `ownCustomerId` is what the caller's own record resolves to when no
// customerId is passed at all (SCRUM-93). Left unset, the parent has no
// billing account yet — the state a family is in before their first card.
function mockOwnerAuth({ ownCustomerId } = {}) {
  const authPath = require.resolve(path.join(backendRoot, 'lib/auth.js'));
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { requireAuth: async () => ({ id: 'parent-1', email: 'parent@example.com', role: 'student' }) },
  };
  const dbPath = require.resolve(path.join(backendRoot, 'lib/db.js'));
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      dbGet: async (queryPath) => {
        // "Does this caller own the customer they named?" — mirrors a real
        // ownership lookup, so a mismatched customerId correctly sees no
        // match rather than matching on the email alone.
        if (queryPath.includes('stripe_customer_id=eq.')) {
          return queryPath.includes('cus_1')
            ? [{ id: 's1', parent_email: 'parent@example.com', stripe_customer_id: 'cus_1' }]
            : [];
        }
        // "Which customer is mine?" — the server-side resolution that
        // replaced the portal digging its own id out of its bookings.
        if (queryPath.includes('select=stripe_customer_id')) {
          return ownCustomerId ? [{ stripe_customer_id: ownCustomerId }] : [];
        }
        return [];
      },
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

// SCRUM-93: a card saved before the family's first lesson was billed used to
// vanish on reload, because the portal could only find its own Stripe
// customer id inside its own bookings. Omitting customerId now means "mine".
test('GET billing?resource=payment-methods with no customerId lists the caller\'s own cards', async () => {
  let askedFor;
  mockPaymentsModule({
    listPaymentMethods: async (id) => {
      askedFor = id;
      return [{ id: 'pm_1', card: { brand: 'visa', last4: '4242', exp_month: 8, exp_year: 2030 } }];
    },
  });
  mockCors();
  mockOwnerAuth({ ownCustomerId: 'cus_1' });
  const handler = require(path.join(backendRoot, 'api/billing.js'));
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'payment-methods' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(askedFor, 'cus_1');
  assert.deepEqual(res.body, [{ id: 'pm_1', brand: 'visa', last4: '4242', expMonth: 8, expYear: 2030 }]);
});

// Having no billing account yet is an ordinary state, not a failure: the
// family simply has no cards. An error here is what put "Couldn't load saved
// cards" in front of every new signup.
test('GET billing?resource=payment-methods returns an empty list when the caller has no billing account', async () => {
  let called = false;
  mockPaymentsModule({ listPaymentMethods: async () => { called = true; return []; } });
  mockCors();
  mockOwnerAuth();
  const handler = require(path.join(backendRoot, 'api/billing.js'));
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'payment-methods' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, []);
  assert.equal(called, false, 'should not call Stripe without a customer');
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

test('POST billing customer-portal with no customerId opens the caller\'s own portal', async () => {
  let captured;
  mockPaymentsModule({
    createCustomerPortalSession: async (params) => { captured = params; return { url: 'https://billing.stripe.com/p/session_1' }; },
  });
  mockCors();
  mockOwnerAuth({ ownCustomerId: 'cus_1' });
  const handler = require(path.join(backendRoot, 'api/billing.js'));
  const res = makeRes();
  await handler({ method: 'POST', body: { resource: 'customer-portal', returnUrl: 'https://example.com/account' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(captured.customerId, 'cus_1');
});

// Unlike listing cards, there is nothing to show someone with no billing
// account — so this one does say so, rather than opening an empty portal.
test('POST billing customer-portal explains itself when the caller has no billing account', async () => {
  mockPaymentsModule({ createCustomerPortalSession: async () => ({ url: 'nope' }) });
  mockCors();
  mockOwnerAuth();
  const handler = require(path.join(backendRoot, 'api/billing.js'));
  const res = makeRes();
  await handler({ method: 'POST', body: { resource: 'customer-portal' } }, res);
  assert.equal(res.statusCode, 404);
  assert.match(res.body.error, /save a card first/i);
});

// The detach path takes the same "omitted means mine" treatment, so the
// portal never has to hold a customer id just to remove a card.
test('POST billing payment-methods detach resolves the caller\'s own customer when none is given', async () => {
  let detached = null;
  mockPaymentsModule({
    listPaymentMethods: async () => [{ id: 'pm_1' }],
    detachPaymentMethod: async (id) => { detached = id; },
  });
  mockCors();
  mockOwnerAuth({ ownCustomerId: 'cus_1' });
  const handler = require(path.join(backendRoot, 'api/billing.js'));
  const res = makeRes();
  await handler({ method: 'POST', body: { resource: 'payment-methods', action: 'detach', paymentMethodId: 'pm_1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(detached, 'pm_1');
});

test('POST billing setup-intent creates a student, a Stripe customer, and persists it', async () => {
  let posted, patched, customerCreated;
  mockPaymentsModule({
    createCustomer: async (params) => { customerCreated = params; return { id: 'cus_new' }; },
    createSetupIntent: async () => ({ client_secret: 'seti_secret_1' }),
  });
  mockCors();
  const authPath = require.resolve(path.join(backendRoot, 'lib/auth.js'));
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { requireAuth: async () => ({ id: 'parent-1', email: 'newparent@example.com', role: 'student' }) },
  };
  const dbPath = require.resolve(path.join(backendRoot, 'lib/db.js'));
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      dbGet: async () => [],
      dbPost: async (p, body) => { posted = body; return { id: 'student-new', ...body }; },
      dbPatch: async (p, body) => { patched = { p, body }; },
    },
  };
  const handler = require(path.join(backendRoot, 'api/billing.js'));
  const res = makeRes();
  await handler({ method: 'POST', body: { resource: 'setup-intent' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.clientSecret, 'seti_secret_1');
  assert.equal(res.body.customerId, 'cus_new');
  assert.equal(posted.parent_email, 'newparent@example.com');
  assert.equal(customerCreated.email, 'newparent@example.com');
  assert.equal(patched.body.stripe_customer_id, 'cus_new');
});

test('POST billing setup-intent reuses an existing Stripe customer instead of creating a duplicate', async () => {
  let customerCreateCalled = false;
  mockPaymentsModule({
    createCustomer: async () => { customerCreateCalled = true; return { id: 'cus_should_not_be_used' }; },
    createSetupIntent: async (params) => { assert.equal(params.customerId, 'cus_existing'); return { client_secret: 'seti_secret_2' }; },
  });
  mockCors();
  mockOwnerAuth(); // parent@example.com already owns cus_1 in this fixture's db mock — reuse the pattern's shape
  const dbPath = require.resolve(path.join(backendRoot, 'lib/db.js'));
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      dbGet: async () => [{ id: 'student-1', parent_name: 'Parent', stripe_customer_id: 'cus_existing' }],
    },
  };
  const handler = require(path.join(backendRoot, 'api/billing.js'));
  const res = makeRes();
  await handler({ method: 'POST', body: { resource: 'setup-intent' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.customerId, 'cus_existing');
  assert.equal(customerCreateCalled, false);
});

test('POST billing setup-intent requires authentication', async () => {
  mockPaymentsModule({});
  mockCors();
  const authPath = require.resolve(path.join(backendRoot, 'lib/auth.js'));
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { requireAuth: async (req, res) => { res.status(401).json({ error: 'Unauthorized' }); return null; } },
  };
  const handler = require(path.join(backendRoot, 'api/billing.js'));
  const res = makeRes();
  await handler({ method: 'POST', body: { resource: 'setup-intent' }, headers: {} }, res);
  assert.equal(res.statusCode, 401);
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
    exports: {
      dbGet: async () => [{ id: 'b1', stripe_payment_intent_id: 'pi_1', fee_pence: 4000 }],
      dbPatch: async () => ({}),
    },
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

// SCRUM-56: cancel-booking/bulk-cancel previously only knew how to refund a
// booking charged directly (the old book-now-pay-now model) — under
// periodic billing, a paid booking's PaymentIntent lives on its
// billing_batches row instead, so these regression-test the fallback.

test('cancel-booking refunds a batch-billed paid booking via its billing_batches PaymentIntent and resets payment_status', async () => {
  let refundedIntentId, refundedAmount;
  mockPaymentsModule({
    createRefund: async ({ paymentIntentId, amount }) => { refundedIntentId = paymentIntentId; refundedAmount = amount; return { id: 're_batch' }; },
  });
  mockCors();
  mockAdminAuth();
  const patches = [];
  const dbPath = require.resolve(path.join(backendRoot, 'lib/db.js'));
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      dbGet: async (p) => {
        if (p.startsWith('/bookings?id=eq.')) return [{ id: '11111111-1111-1111-1111-111111111111', payment_status: 'paid', stripe_payment_intent_id: null, billing_batch_id: 'batch-1', fee_pence: 4000 }];
        if (p.startsWith('/billing_batches?id=eq.')) return [{ id: 'batch-1', stripe_payment_intent_id: 'pi_batch' }];
        return [];
      },
      dbPatch: async (p, body) => { patches.push({ path: p, body }); return {}; },
    },
  };
  const handler = require(path.join(backendRoot, 'api/analytics.js'));
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'cancel-booking', bookingId: '11111111-1111-1111-1111-111111111111' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.refunded, true);
  assert.equal(refundedIntentId, 'pi_batch');
  assert.equal(refundedAmount, 4000);
  assert.equal(patches[0].body.status, 'cancelled');
  assert.equal(patches[0].body.payment_status, 'refunded');
});

test('cancel-booking cancels without a refund attempt for an already-unbilled booking', async () => {
  mockPaymentsModule({ createRefund: async () => { throw new Error('should not be called'); } });
  mockCors();
  mockAdminAuth();
  const patches = [];
  const dbPath = require.resolve(path.join(backendRoot, 'lib/db.js'));
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      dbGet: async () => [{ id: 'b1', payment_status: 'unbilled', billing_batch_id: null, fee_pence: 4000 }],
      dbPatch: async (p, body) => { patches.push({ path: p, body }); return {}; },
    },
  };
  const handler = require(path.join(backendRoot, 'api/analytics.js'));
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'cancel-booking', bookingId: '11111111-1111-1111-1111-111111111111' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.refunded, false);
  assert.equal(patches[0].body.payment_status, undefined);
});

test('bulk-cancel refunds batch-billed paid bookings via billing_batches and alerts on partial failure', async () => {
  mockPaymentsModule({
    createRefund: async ({ paymentIntentId }) => {
      if (paymentIntentId === 'pi_fails') throw new Error('card_declined');
      return { id: 're_' + paymentIntentId };
    },
  });
  mockCors();
  mockAdminAuth();
  const patches = [];
  const alerts = [];
  const dbPath = require.resolve(path.join(backendRoot, 'lib/db.js'));
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      dbGet: async (p) => {
        if (p.startsWith('/bookings?status=eq.confirmed')) {
          return [
            { id: 'b1', payment_status: 'paid', stripe_payment_intent_id: null, billing_batch_id: 'batch-ok', fee_pence: 4000 },
            { id: 'b2', payment_status: 'paid', stripe_payment_intent_id: null, billing_batch_id: 'batch-fail', fee_pence: 4000 },
            { id: 'b3', payment_status: 'unbilled', billing_batch_id: null, fee_pence: 4000 },
          ];
        }
        if (p.startsWith('/billing_batches?id=eq.batch-ok')) return [{ id: 'batch-ok', stripe_payment_intent_id: 'pi_ok' }];
        if (p.startsWith('/billing_batches?id=eq.batch-fail')) return [{ id: 'batch-fail', stripe_payment_intent_id: 'pi_fails' }];
        return [];
      },
      supabaseRequest: async (p, opts) => {
        if (opts?.method === 'PATCH' && p.startsWith('/bookings?id=eq.')) {
          patches.push({ path: p, body: JSON.parse(opts.body) });
        }
        return { ok: true, json: async () => ({}) };
      },
    },
  };
  const loggerPath = require.resolve(path.join(backendRoot, 'lib/logger.js'));
  require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { alertCritical: async (subject, details) => { alerts.push({ subject, details }); }, logError: () => {} },
  };
  const handler = require(path.join(backendRoot, 'api/lifecycle.js'));
  const res = makeRes();
  await handler({ method: 'POST', query: { resource: 'bulk-cancel' }, body: { date: '2026-08-01' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.cancelled, 3);
  assert.equal(res.body.refunded, 1);
  assert.equal(res.body.refundFailed, 1);
  assert.equal(alerts.length, 1);

  const b1Patch = patches.find(p => p.path.includes('b1')).body;
  assert.equal(b1Patch.status, 'cancelled');
  assert.equal(b1Patch.payment_status, 'refunded');

  const b2Patch = patches.find(p => p.path.includes('b2')).body;
  assert.equal(b2Patch.status, 'cancelled');
  assert.equal(b2Patch.payment_status, undefined, 'failed refund must not be marked refunded');

  const b3Patch = patches.find(p => p.path.includes('b3')).body;
  assert.equal(b3Patch.status, 'cancelled');
  assert.equal(b3Patch.payment_status, undefined);
});
