const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const backendRoot = path.join(__dirname, '..');

function loadWebhookHandler({ dbMock, dbGetMock, sendBookingConfirmationMock, event, loggerMock } = {}) {
  for (const k of Object.keys(require.cache)) delete require.cache[k];

  const rawBodyPath = require.resolve('raw-body');
  require.cache[rawBodyPath] = { id: rawBodyPath, filename: rawBodyPath, loaded: true, exports: async () => Buffer.from('{}') };

  const stripePath = require.resolve('stripe');
  require.cache[stripePath] = {
    id: stripePath, filename: stripePath, loaded: true,
    exports: () => ({ webhooks: { constructEvent: () => event } }),
  };

  const dbPath = require.resolve(path.join(backendRoot, 'lib/db.js'));
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: { supabaseRequest: dbMock, dbGet: dbGetMock || (async () => []) },
  };

  const remindersPath = require.resolve(path.join(backendRoot, 'lib/reminders.js'));
  require.cache[remindersPath] = {
    id: remindersPath, filename: remindersPath, loaded: true,
    exports: { sendBookingConfirmation: sendBookingConfirmationMock || (async () => {}) },
  };

  if (loggerMock) {
    const loggerPath = require.resolve(path.join(backendRoot, 'lib/logger.js'));
    require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true, exports: loggerMock };
  }

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

test('checkout.session.completed confirms the booking and sends the confirmation email', async () => {
  const patches = [];
  let emailSent = null;
  const handler = loadWebhookHandler({
    event: {
      id: 'evt_checkout_1', type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', payment_intent: 'pi_1', metadata: { bookingId: 'b1' } } },
    },
    dbMock: async (path, opts) => {
      if (path === '/stripe_webhook_events') return { ok: true, json: async () => ({}) };
      patches.push({ path, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({}) };
    },
    dbGetMock: async (path) => {
      if (path.startsWith('/bookings?id=eq.b1')) {
        return [{
          id: 'b1', tutor_name: 'Azeem', subject: 'Maths', lesson_type: 'gcse',
          start_time: new Date().toISOString(), duration_mins: 55, fee_pence: 4000, meet_link: 'https://meet.example',
          students: { student_name: 'Student', parent_name: 'Parent', parent_email: 'p@example.com', parent_phone: null },
        }];
      }
      return [];
    },
    sendBookingConfirmationMock: async (params) => { emailSent = params; },
  });
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(patches.some(p => p.path.includes('/bookings?id=eq.b1') && p.body.status === 'confirmed'), true);
  assert.ok(emailSent, 'confirmation email should have been sent');
  assert.equal(emailSent.parentEmail, 'p@example.com');
});

test('checkout.session.completed does not crash if the confirmation email fails', async () => {
  const handler = loadWebhookHandler({
    event: {
      id: 'evt_checkout_2', type: 'checkout.session.completed',
      data: { object: { id: 'cs_2', payment_intent: 'pi_2', metadata: { bookingId: 'b2' } } },
    },
    dbMock: async (path) => (path === '/stripe_webhook_events' ? { ok: true, json: async () => ({}) } : { ok: true, json: async () => ({}) }),
    dbGetMock: async () => { throw new Error('db unreachable'); },
  });
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.received, true);
});

test('checkout.session.expired marks an unpaid scheduled booking as payment_failed', async () => {
  const patches = [];
  const handler = loadWebhookHandler({
    event: {
      id: 'evt_expired_1', type: 'checkout.session.expired',
      data: { object: { id: 'cs_3', metadata: { bookingId: 'b3' } } },
    },
    dbMock: async (path, opts) => {
      if (path === '/stripe_webhook_events') return { ok: true, json: async () => ({}) };
      patches.push({ path, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({}) };
    },
  });
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(patches[0].path, '/bookings?id=eq.b3&status=eq.scheduled');
  assert.equal(patches[0].body.status, 'payment_failed');
});

test('payment_intent.payment_failed marks the linked booking as payment_failed', async () => {
  const patches = [];
  const handler = loadWebhookHandler({
    event: {
      id: 'evt_failed_1', type: 'payment_intent.payment_failed',
      data: { object: { id: 'pi_3', metadata: { bookingId: 'b4' }, last_payment_error: { message: 'card declined' } } },
    },
    dbMock: async (path, opts) => {
      if (path === '/stripe_webhook_events') return { ok: true, json: async () => ({}) };
      patches.push({ path, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({}) };
    },
  });
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(patches[0].path, '/bookings?id=eq.b4');
  assert.equal(patches[0].body.status, 'payment_failed');
});

test('payment_intent.payment_failed alerts the admin, not just logs a line', async () => {
  const alerts = [];
  const handler = loadWebhookHandler({
    event: {
      id: 'evt_failed_2', type: 'payment_intent.payment_failed',
      data: { object: { id: 'pi_5', metadata: { bookingId: 'b9' }, last_payment_error: { message: 'insufficient funds' } } },
    },
    dbMock: async () => ({ ok: true, json: async () => ({}) }),
    loggerMock: {
      logError: () => {},
      alertCritical: async (subject, details) => { alerts.push({ subject, details }); },
    },
  });
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].subject, /Payment failed/i);
  assert.match(alerts[0].details, /pi_5/);
  assert.match(alerts[0].details, /insufficient funds/);
});

test('rejects non-POST requests', async () => {
  const handler = loadWebhookHandler({ event: {}, dbMock: async () => ({ ok: true, json: async () => ({}) }) });
  const res = makeRes();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 405);
});
