const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const backendRoot = path.join(__dirname, '..');

function mockModule(relPath, exportsObj) {
  const resolved = require.resolve(path.join(backendRoot, relPath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
function setup({ dbRpc, payments } = {}) {
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  mockModule('lib/cors.js', { applyCors: () => false });
  mockModule('lib/db.js', { dbRpc: dbRpc || (async () => true) });
  mockModule('lib/payments/index.js', { getPaymentService: () => payments || {} });
}
function makeRes() {
  const res = {};
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('create-payment-intent is rate-limited by IP (SCRUM-20)', async () => {
  setup({ dbRpc: async () => false });
  const handler = require(path.join(backendRoot, 'api/create-payment-intent.js'));
  const res = makeRes();
  await handler({ method: 'POST', headers: {}, body: { lessonType: 'gcse', studentLevel: 'gcse' } }, res);
  assert.equal(res.statusCode, 429);
});

test('create-payment-intent proceeds normally when under the rate limit', async () => {
  setup({ dbRpc: async () => true, payments: { createPaymentIntent: async () => ({ status: 'succeeded', id: 'pi_1' }) } });
  const handler = require(path.join(backendRoot, 'api/create-payment-intent.js'));
  const res = makeRes();
  await handler({ method: 'POST', headers: {}, body: { lessonType: 'trial', studentLevel: 'gcse' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'free');
});

test('create-setup-intent is rate-limited by IP (SCRUM-20)', async () => {
  setup({ dbRpc: async () => false });
  const handler = require(path.join(backendRoot, 'api/create-setup-intent.js'));
  const res = makeRes();
  await handler({ method: 'POST', headers: {}, body: { parentEmail: 'p@example.com' } }, res);
  assert.equal(res.statusCode, 429);
});

test('create-setup-intent proceeds normally when under the rate limit', async () => {
  setup({
    dbRpc: async () => true,
    payments: {
      createCustomer: async () => ({ id: 'cus_1' }),
      createSetupIntent: async () => ({ client_secret: 'seti_secret' }),
    },
  });
  const handler = require(path.join(backendRoot, 'api/create-setup-intent.js'));
  const res = makeRes();
  await handler({ method: 'POST', headers: {}, body: { parentEmail: 'p@example.com' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.customerId, 'cus_1');
});
