const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');

const backendRoot = path.join(__dirname, '..');
const SIGNING_KEY = 'test-calendly-key';

function sign(rawBody) {
  const t = '1700000000';
  const sig = crypto.createHmac('sha256', SIGNING_KEY).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${sig}`;
}

function loadHandler({ dbGetMock, dbPostMock, dbMock, paymentsMock, remindersMock } = {}) {
  for (const k of Object.keys(require.cache)) delete require.cache[k];

  const dbPath = require.resolve(path.join(backendRoot, 'lib/db.js'));
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      dbGet: dbGetMock || (async () => []),
      dbPost: dbPostMock || (async () => ({ id: 'x' })),
      supabaseRequest: dbMock || (async () => ({ ok: true, json: async () => ({}) })),
    },
  };

  const paymentsIndexPath = require.resolve(path.join(backendRoot, 'lib/payments/index.js'));
  require.cache[paymentsIndexPath] = {
    id: paymentsIndexPath, filename: paymentsIndexPath, loaded: true,
    exports: {
      getPaymentService: () => paymentsMock || {
        createCheckoutSession: async () => ({ id: 'cs_1', url: 'https://checkout.stripe.com/cs_1' }),
      },
    },
  };

  const remindersPath = require.resolve(path.join(backendRoot, 'lib/reminders.js'));
  require.cache[remindersPath] = {
    id: remindersPath, filename: remindersPath, loaded: true,
    exports: {
      sendBookingConfirmation: async () => {},
      sendPaymentLink: async () => {},
      ...remindersMock,
    },
  };

  process.env.CALENDLY_WEBHOOK_SIGNING_KEY = SIGNING_KEY;
  return require(path.join(backendRoot, 'api/calendly-webhook.js'));
}

function makeRes() {
  const res = {};
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

function inviteeCreatedBody(overrides = {}) {
  return {
    event: 'invitee.created',
    payload: {
      uri: 'https://api.calendly.com/scheduled_events/e1/invitees/i1',
      email: 'parent@example.com',
      name: 'Parent Name',
      tracking: { utm_content: 'lead-1' },
      scheduled_event: {
        uri: 'https://api.calendly.com/scheduled_events/e1',
        event_type: 'https://api.calendly.com/event_types/azeem-gcse',
        start_time: '2026-09-01T10:00:00.000000Z',
        end_time: '2026-09-01T10:55:00.000000Z',
      },
      ...overrides,
    },
  };
}

test('rejects a request with an invalid signature', async () => {
  const handler = loadHandler({});
  const res = makeRes();
  const body = inviteeCreatedBody();
  await handler({ method: 'POST', headers: { 'calendly-webhook-signature': 'bad' }, body }, res);
  assert.equal(res.statusCode, 400);
});

test('invitee.created for a paid lesson creates a scheduled booking and a checkout session', async () => {
  const posted = [];
  let checkoutCreated = null;
  let paymentLinkEmail = null;
  const body = inviteeCreatedBody();
  const raw = JSON.stringify(body);
  const handler = loadHandler({
    dbGetMock: async (p) => {
      if (p.startsWith('/leads?')) return [{ id: 'lead-1', name: 'Parent Name', email: 'parent@example.com', subject: 'Maths', level: 'gcse', notes: null, assigned_tutor: 'Azeem' }];
      if (p.startsWith('/profiles?')) return [{ tutor_name: 'Azeem' }];
      if (p.startsWith('/students?')) return [{ id: 'student-1' }];
      return [];
    },
    dbPostMock: async (p, b) => { posted.push({ p, b }); return { id: 'booking-1', ...b }; },
    dbMock: async (p, opts) => ({ ok: true, json: async () => ({}) }),
    paymentsMock: {
      createCheckoutSession: async (params) => { checkoutCreated = params; return { id: 'cs_1', url: 'https://checkout.stripe.com/cs_1' }; },
    },
    remindersMock: { sendPaymentLink: async (params) => { paymentLinkEmail = params; } },
  });
  const res = makeRes();
  await handler({ method: 'POST', headers: { 'calendly-webhook-signature': sign(raw) }, body }, res);
  assert.equal(res.statusCode, 200);
  const bookingInsert = posted.find(p => p.p === '/bookings');
  assert.ok(bookingInsert, 'should insert a bookings row');
  assert.equal(bookingInsert.b.status, 'scheduled');
  assert.equal(bookingInsert.b.tutor_name, 'Azeem');
  assert.ok(checkoutCreated, 'should create a checkout session for a paid lesson');
  assert.equal(checkoutCreated.metadata.bookingId, 'booking-1');
  assert.ok(paymentLinkEmail, 'should email the payment link');
});

test('invitee.created for a free trial confirms the booking directly, no checkout', async () => {
  const posted = [];
  let checkoutCreated = false;
  let confirmationSent = false;
  const body = inviteeCreatedBody();
  body.payload.tracking.utm_content = 'lead-2';
  const raw = JSON.stringify(body);
  const handler = loadHandler({
    dbGetMock: async (p) => {
      if (p.startsWith('/leads?')) return [{ id: 'lead-2', name: 'P', email: 'parent2@example.com', subject: 'Maths', level: 'gcse', notes: '{"trial":true}', assigned_tutor: 'Azeem' }];
      if (p.startsWith('/profiles?')) return [{ tutor_name: 'Azeem' }];
      if (p.startsWith('/students?')) return [];
      return [];
    },
    dbPostMock: async (p, b) => { posted.push({ p, b }); return { id: 'booking-2', ...b }; },
    paymentsMock: { createCheckoutSession: async () => { checkoutCreated = true; return {}; } },
    remindersMock: { sendBookingConfirmation: async () => { confirmationSent = true; } },
  });
  const res = makeRes();
  await handler({ method: 'POST', headers: { 'calendly-webhook-signature': sign(raw) }, body }, res);
  assert.equal(res.statusCode, 200);
  const bookingInsert = posted.find(p => p.p === '/bookings');
  assert.equal(bookingInsert.b.status, 'confirmed');
  assert.equal(bookingInsert.b.fee_pence, 0);
  assert.equal(checkoutCreated, false, 'must not create a checkout session for a free trial');
  assert.equal(confirmationSent, true);
});

test('invitee.created with no tracking id is skipped gracefully (no crash)', async () => {
  const body = inviteeCreatedBody();
  delete body.payload.tracking;
  const raw = JSON.stringify(body);
  const handler = loadHandler({});
  const res = makeRes();
  await handler({ method: 'POST', headers: { 'calendly-webhook-signature': sign(raw) }, body }, res);
  assert.equal(res.statusCode, 200);
});

test('invitee.canceled marks the linked booking cancelled', async () => {
  const patches = [];
  const body = {
    event: 'invitee.canceled',
    payload: { uri: 'https://api.calendly.com/scheduled_events/e1/invitees/i1' },
  };
  const raw = JSON.stringify(body);
  const handler = loadHandler({
    dbMock: async (p, opts) => {
      if (p === '/calendly_webhook_events') return { ok: true, json: async () => ({}) };
      patches.push({ p, b: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({}) };
    },
  });
  const res = makeRes();
  await handler({ method: 'POST', headers: { 'calendly-webhook-signature': sign(raw) }, body }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(patches[0].b.status, 'cancelled');
});

test('short-circuits a redelivered event', async () => {
  const body = inviteeCreatedBody();
  const raw = JSON.stringify(body);
  const handler = loadHandler({
    dbMock: async (p) => (p === '/calendly_webhook_events' ? { ok: false, status: 409, json: async () => ({}) } : { ok: true, json: async () => ({}) }),
  });
  const res = makeRes();
  await handler({ method: 'POST', headers: { 'calendly-webhook-signature': sign(raw) }, body }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.duplicate, true);
});

test('rejects non-POST requests', async () => {
  const handler = loadHandler({});
  const res = makeRes();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 405);
});
