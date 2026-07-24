const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const backendRoot = path.join(__dirname, '..');

function mockModule(relPath, exportsObj) {
  const resolved = require.resolve(path.join(backendRoot, relPath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

function loadHandler({ dbGetMock, dbPatchMock, callerEmail } = {}) {
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  mockModule('lib/cors.js', { applyCors: () => false });
  mockModule('lib/auth.js', {
    requireAuth: async () => ({ id: 'parent-1', role: 'student', email: callerEmail || 'parent@example.com' }),
  });
  mockModule('lib/payments/index.js', { getPaymentService: () => ({}) });
  mockModule('lib/db.js', {
    dbGet: dbGetMock || (async () => []),
    dbPatch: dbPatchMock || (async () => ({})),
    dbPost: async () => ({}),
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

test('GET billing?resource=billing-cycle returns the caller\'s own billing_cycle', async () => {
  const handler = loadHandler({
    dbGetMock: async (p) => {
      assert.ok(p.includes('parent%40example.com'), 'looks up by the caller\'s own normalized email');
      return [{ billing_cycle: 'monthly' }];
    },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'billing-cycle' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.billingCycle, 'monthly');
});

test('GET billing?resource=billing-cycle defaults to weekly when the family has no student record yet', async () => {
  const handler = loadHandler({ dbGetMock: async () => [] });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'billing-cycle' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.billingCycle, 'weekly');
});

test('POST billing resource=billing-cycle lets a family switch to monthly billing', async () => {
  let patched = null;
  const handler = loadHandler({
    dbGetMock: async () => [{ id: 's1', parent_email: 'parent@example.com' }],
    dbPatchMock: async (p, body) => { patched = { p, body }; return {}; },
  });
  const res = makeRes();
  await handler({ method: 'POST', body: { resource: 'billing-cycle', billingCycle: 'monthly' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.billingCycle, 'monthly');
  assert.equal(patched.body.billing_cycle, 'monthly');
});

test('POST billing resource=billing-cycle rejects an invalid cadence', async () => {
  const handler = loadHandler();
  const res = makeRes();
  await handler({ method: 'POST', body: { resource: 'billing-cycle', billingCycle: 'daily' } }, res);
  assert.equal(res.statusCode, 400);
});

test('POST billing resource=billing-cycle 404s when the caller has no student record at all', async () => {
  const handler = loadHandler({ dbGetMock: async () => [] });
  const res = makeRes();
  await handler({ method: 'POST', body: { resource: 'billing-cycle', billingCycle: 'weekly' } }, res);
  assert.equal(res.statusCode, 404);
});
