const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const backendRoot = path.join(__dirname, '..');

function loadWebhookHandler({ dbMock, event } = {}) {
  for (const k of Object.keys(require.cache)) delete require.cache[k];

  const rawBodyPath = require.resolve('raw-body');
  require.cache[rawBodyPath] = { id: rawBodyPath, filename: rawBodyPath, loaded: true, exports: async () => Buffer.from('{}') };

  const stripePath = require.resolve('stripe');
  require.cache[stripePath] = {
    id: stripePath, filename: stripePath, loaded: true,
    exports: () => ({ webhooks: { constructEvent: () => event } }),
  };

  const dbPath = require.resolve(path.join(backendRoot, 'lib/db.js'));
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { supabaseRequest: dbMock } };

  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';

  return require(path.join(backendRoot, 'api/webhook.js'));
}

function makeReq(headers = { 'stripe-signature': 'sig' }) {
  return { method: 'POST', headers };
}
function makeRes() {
  const res = {};
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.send = (b) => { res.body = b; return res; };
  return res;
}

test('processes a new event and records it for dedup', async () => {
  const dedupCalls = [];
  const handler = loadWebhookHandler({
    event: { id: 'evt_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1', amount: 100, metadata: {} } } },
    dbMock: async (path) => {
      dedupCalls.push(path);
      return { ok: true, json: async () => ({}) };
    },
  });
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.received, true);
  assert.equal(dedupCalls[0], '/stripe_webhook_events');
});

test('short-circuits a redelivered event without re-running side effects', async () => {
  let bookingPatchCalled = false;
  const handler = loadWebhookHandler({
    event: { id: 'evt_dup', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1', metadata: { bookingId: 'b1' } } } },
    dbMock: async (path) => {
      if (path === '/stripe_webhook_events') return { ok: false, status: 409, json: async () => ({}) };
      bookingPatchCalled = true;
      return { ok: true, json: async () => ({}) };
    },
  });
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.duplicate, true);
  assert.equal(bookingPatchCalled, false, 'must not re-run booking update for a duplicate event');
});

test('returns 500 if the dedup check itself fails (fail closed, not open)', async () => {
  const handler = loadWebhookHandler({
    event: { id: 'evt_2', type: 'payment_intent.succeeded', data: { object: {} } },
    dbMock: async () => { throw new Error('network error'); },
  });
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res.statusCode, 500);
});

test('rejects non-POST requests', async () => {
  const handler = loadWebhookHandler({ event: {}, dbMock: async () => ({ ok: true, json: async () => ({}) }) });
  const res = makeRes();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 405);
});
