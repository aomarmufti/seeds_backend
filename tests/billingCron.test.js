const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const backendRoot = path.join(__dirname, '..');

function mockModule(relPath, exportsObj) {
  const resolved = require.resolve(path.join(backendRoot, relPath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
function mockPackage(pkgName, exportsObj) {
  const resolved = require.resolve(pkgName);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

function loadHandler({ dbGetMock, dbPostMock, dbPatchMock, paymentsMock } = {}) {
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  mockModule('lib/cors.js', { applyCors: () => false });
  mockPackage('nodemailer', { createTransport: () => ({ sendMail: async () => ({}) }) });
  mockModule('lib/payments/index.js', { getPaymentService: () => paymentsMock || {} });
  mockModule('lib/db.js', {
    dbGet: dbGetMock || (async () => []),
    dbPost: dbPostMock || (async (p, b) => ({ id: 'batch-1', ...b })),
    dbPatch: dbPatchMock || (async () => ({})),
    supabaseRequest: async () => ({ ok: true, json: async () => ({}) }),
  });
  return require(path.join(backendRoot, 'api/billing.js'));
}

function makeRes() {
  const res = {};
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('GET billing?resource=billing-cron rejects a caller without the cron secret', async () => {
  delete process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'shh';
  const handler = loadHandler();
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'billing-cron' }, headers: {} }, res);
  assert.equal(res.statusCode, 401);
});

test('billing-cron is a no-op on a day that is neither a Monday nor the 1st of the month', async (t) => {
  process.env.CRON_SECRET = 'shh';
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-05T06:00:00Z') }); // Wednesday the 5th
  const handler = loadHandler();
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'billing-cron' }, headers: { authorization: 'Bearer shh' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.processed, 0);
});

test('billing-cron charges a weekly family\'s saved card for its unbilled, already-happened lessons', async (t) => {
  process.env.CRON_SECRET = 'shh';
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-03T06:00:00Z') }); // Monday
  const patches = [];
  let chargeParams = null;
  const handler = loadHandler({
    dbGetMock: async (p) => {
      if (p.startsWith('/students?billing_cycle=eq.weekly')) {
        return [{ id: 'student-1', parent_email: 'parent@example.com', parent_name: 'Parent', stripe_customer_id: 'cus_1' }];
      }
      if (p.startsWith('/bookings?student_id=eq.student-1')) {
        return [
          { id: 'b1', fee_pence: 4000, start_time: '2026-07-27T10:00:00Z' },
          { id: 'b2', fee_pence: 4500, start_time: '2026-07-29T10:00:00Z' },
        ];
      }
      return [];
    },
    dbPatchMock: async (p, body) => { patches.push({ p, body }); return {}; },
    paymentsMock: {
      listPaymentMethods: async (customerId) => customerId === 'cus_1' ? [{ id: 'pm_1' }] : [],
      createPaymentIntent: async (params) => { chargeParams = params; return { id: 'pi_1' }; },
    },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'billing-cron' }, headers: { authorization: 'Bearer shh' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.results[0].status, 'charged');
  assert.equal(res.body.results[0].totalPence, 8500);
  assert.equal(chargeParams.amount, 8500);
  assert.equal(chargeParams.customerId, 'cus_1');
  assert.equal(chargeParams.offSession, true);
  const batchPatch = patches.find(p => p.p.startsWith('/billing_batches'));
  assert.equal(batchPatch.body.status, 'paid');
  const bookingsPatch = patches.find(p => p.p.startsWith('/bookings?id=in.'));
  assert.equal(bookingsPatch.body.payment_status, 'paid');
  assert.ok(bookingsPatch.p.includes('b1') && bookingsPatch.p.includes('b2'));
});

test('billing-cron emails a Checkout payment link when the family has no saved card', async (t) => {
  process.env.CRON_SECRET = 'shh';
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-01T06:00:00Z') }); // 1st of the month
  const patches = [];
  let checkoutParams = null;
  const handler = loadHandler({
    dbGetMock: async (p) => {
      if (p.startsWith('/students?billing_cycle=eq.monthly')) {
        return [{ id: 'student-2', parent_email: 'parent2@example.com', parent_name: 'Parent Two', stripe_customer_id: null }];
      }
      if (p.startsWith('/bookings?student_id=eq.student-2')) {
        return [{ id: 'b3', fee_pence: 2000, start_time: '2026-08-15T10:00:00Z' }];
      }
      return [];
    },
    dbPatchMock: async (p, body) => { patches.push({ p, body }); return {}; },
    paymentsMock: {
      createCheckoutSession: async (params) => { checkoutParams = params; return { id: 'cs_1', url: 'https://checkout.stripe.com/cs_1' }; },
    },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'billing-cron' }, headers: { authorization: 'Bearer shh' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.results[0].status, 'payment_link_sent');
  assert.equal(checkoutParams.amount, 2000);
  assert.equal(checkoutParams.metadata.billingBatchId, 'batch-1');
  const batchPatch = patches.find(p => p.p.startsWith('/billing_batches'));
  assert.equal(batchPatch.body.status, 'payment_link_sent');
  const bookingsPatch = patches.find(p => p.p.startsWith('/bookings?id=in.'));
  assert.equal(bookingsPatch.body.payment_status, 'invoiced');
});

test('billing-cron falls back to a payment link when the saved card is declined', async (t) => {
  process.env.CRON_SECRET = 'shh';
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-03T06:00:00Z') }); // Monday
  let checkoutCreated = false;
  const handler = loadHandler({
    dbGetMock: async (p) => {
      if (p.startsWith('/students?billing_cycle=eq.weekly')) {
        return [{ id: 'student-3', parent_email: 'parent3@example.com', stripe_customer_id: 'cus_3' }];
      }
      if (p.startsWith('/bookings?student_id=eq.student-3')) {
        return [{ id: 'b4', fee_pence: 4000, start_time: '2026-07-28T10:00:00Z' }];
      }
      return [];
    },
    paymentsMock: {
      listPaymentMethods: async () => [{ id: 'pm_declined' }],
      createPaymentIntent: async () => { throw new Error('Your card was declined.'); },
      createCheckoutSession: async () => { checkoutCreated = true; return { id: 'cs_2', url: 'https://checkout.stripe.com/cs_2' }; },
    },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'billing-cron' }, headers: { authorization: 'Bearer shh' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.results[0].status, 'payment_link_sent');
  assert.equal(checkoutCreated, true, 'declined off-session charge should fall back to a payment link, not fail silently');
});

test('billing-cron skips a family due today with nothing unbilled', async (t) => {
  process.env.CRON_SECRET = 'shh';
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-03T06:00:00Z') }); // Monday
  const handler = loadHandler({
    dbGetMock: async (p) => {
      if (p.startsWith('/students?billing_cycle=eq.weekly')) {
        return [{ id: 'student-4', parent_email: 'parent4@example.com', stripe_customer_id: 'cus_4' }];
      }
      return [];
    },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'billing-cron' }, headers: { authorization: 'Bearer shh' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.results[0].status, 'nothing_due');
});
