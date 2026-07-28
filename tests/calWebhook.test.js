const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');

const backendRoot = path.join(__dirname, '..');
const SIGNING_SECRET = 'test-cal-secret';

function sign(rawBody) {
  return crypto.createHmac('sha256', SIGNING_SECRET).update(rawBody).digest('hex');
}

function loadHandler({ dbGetMock, dbPostMock, dbMock, paymentsMock, remindersMock, rawBody } = {}) {
  for (const k of Object.keys(require.cache)) delete require.cache[k];

  const rawBodyModulePath = require.resolve('raw-body');
  require.cache[rawBodyModulePath] = {
    id: rawBodyModulePath, filename: rawBodyModulePath, loaded: true,
    exports: async () => Buffer.from(rawBody || '{}'),
  };

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
      ...remindersMock,
    },
  };

  process.env.CAL_WEBHOOK_SIGNING_SECRET = SIGNING_SECRET;
  return require(path.join(backendRoot, 'api/webhook.js'));
}

function makeRes() {
  const res = {};
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

function bookingCreatedBody(overrides = {}) {
  return {
    triggerEvent: 'BOOKING_CREATED',
    payload: {
      uid: 'booking-uid-1',
      type: 'consultation',
      startTime: '2026-09-01T10:00:00.000Z',
      endTime: '2026-09-01T10:15:00.000Z',
      attendees: [{ email: 'parent@example.com', name: 'Parent Name' }],
      metadata: { trackingId: 'lead-1' },
      ...overrides,
    },
  };
}

test('rejects a Cal.com request with an invalid signature', async () => {
  const raw = JSON.stringify(bookingCreatedBody());
  const handler = loadHandler({ rawBody: raw });
  const res = makeRes();
  await handler({ method: 'POST', headers: { 'x-cal-signature-256': 'bad' } }, res);
  assert.equal(res.statusCode, 400);
});

test('BOOKING_CREATED always confirms a free Initial Consultation booking, deferred to periodic billing for any later paid lessons', async () => {
  const posted = [];
  let confirmationSent = false;
  const raw = JSON.stringify(bookingCreatedBody());
  const handler = loadHandler({
    rawBody: raw,
    dbGetMock: async (p) => {
      if (p.startsWith('/leads?')) return [{ id: 'lead-1', name: 'Parent Name', email: 'parent@example.com', subject: 'Maths', level: 'gcse', assigned_tutor: 'Azeem Omar-Mufti' }];
      if (p.startsWith('/students?')) return [{ id: 'student-1' }];
      return [];
    },
    dbPostMock: async (p, b) => { posted.push({ p, b }); return { id: 'booking-1', ...b }; },
    dbMock: async () => ({ ok: true, json: async () => ({}) }),
    remindersMock: { sendBookingConfirmation: async () => { confirmationSent = true; } },
  });
  const res = makeRes();
  await handler({ method: 'POST', headers: { 'x-cal-signature-256': sign(raw) } }, res);
  assert.equal(res.statusCode, 200);
  const bookingInsert = posted.find(p => p.p === '/bookings');
  assert.ok(bookingInsert, 'should insert a bookings row');
  assert.equal(bookingInsert.b.lesson_type, 'consultation');
  assert.equal(bookingInsert.b.status, 'confirmed');
  assert.equal(bookingInsert.b.payment_status, 'free');
  assert.equal(bookingInsert.b.fee_pence, 0);
  assert.equal(bookingInsert.b.tutor_name, 'Azeem Omar-Mufti');
  assert.equal(bookingInsert.b.cal_booking_uid, 'booking-uid-1');
  assert.equal(confirmationSent, true);
});

test('BOOKING_CREATED with no tracking id is skipped gracefully (no crash)', async () => {
  const body = bookingCreatedBody();
  delete body.payload.metadata;
  const raw = JSON.stringify(body);
  const handler = loadHandler({ rawBody: raw });
  const res = makeRes();
  await handler({ method: 'POST', headers: { 'x-cal-signature-256': sign(raw) } }, res);
  assert.equal(res.statusCode, 200);
});

test('BOOKING_CREATED for a lead with no assigned tutor is skipped gracefully (no crash)', async () => {
  const raw = JSON.stringify(bookingCreatedBody());
  const handler = loadHandler({
    rawBody: raw,
    dbGetMock: async (p) => {
      if (p.startsWith('/leads?')) return [{ id: 'lead-1', name: 'Parent Name', email: 'parent@example.com', assigned_tutor: null }];
      return [];
    },
  });
  const res = makeRes();
  await handler({ method: 'POST', headers: { 'x-cal-signature-256': sign(raw) } }, res);
  assert.equal(res.statusCode, 200);
});

test('BOOKING_CANCELLED marks the linked booking cancelled', async () => {
  const patches = [];
  const body = {
    triggerEvent: 'BOOKING_CANCELLED',
    payload: { uid: 'booking-uid-1' },
  };
  const raw = JSON.stringify(body);
  const handler = loadHandler({
    rawBody: raw,
    dbMock: async (p, opts) => {
      if (p === '/cal_webhook_events') return { ok: true, json: async () => ({}) };
      patches.push({ p, b: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({}) };
    },
  });
  const res = makeRes();
  await handler({ method: 'POST', headers: { 'x-cal-signature-256': sign(raw) } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(patches[0].b.status, 'cancelled');
});

test('short-circuits a redelivered Cal.com event', async () => {
  const raw = JSON.stringify(bookingCreatedBody());
  const handler = loadHandler({
    rawBody: raw,
    dbMock: async (p) => (p === '/cal_webhook_events' ? { ok: false, status: 409, json: async () => ({}) } : { ok: true, json: async () => ({}) }),
  });
  const res = makeRes();
  await handler({ method: 'POST', headers: { 'x-cal-signature-256': sign(raw) } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.duplicate, true);
});
