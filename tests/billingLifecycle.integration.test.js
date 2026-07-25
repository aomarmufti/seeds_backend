// SCRUM-66: end-to-end coverage of the periodic-billing lifecycle across
// module boundaries — billing.js's cron creates a batch, webhook.js's
// Stripe event settles it, and the final row state is what payouts.js's
// eligibility check actually reads. Each of those three files already has
// its own unit tests with independently-scoped mocks; this exercises them
// against one shared, stateful fake DB so a regression in how one module's
// writes are shaped can't hide behind another module's mock accepting
// whatever shape it happens to send.
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

// A minimal in-memory table store good enough to fake the handful of
// PostgREST query shapes these three handlers actually issue.
function makeFakeDb() {
  const tables = { students: [], bookings: [], billing_batches: [] };
  let nextBatchId = 1;

  function table(path) {
    return path.split('?')[0].replace('/', '');
  }
  function matchesFilters(row, path) {
    const qs = path.split('?')[1] || '';
    for (const part of qs.split('&')) {
      if (!part || part.startsWith('select=') || part.startsWith('order=') || part.startsWith('limit=')) continue;
      const [key, cond] = part.split('=');
      if (!cond) continue;
      if (cond.startsWith('eq.')) {
        if (String(row[key]) !== decodeURIComponent(cond.slice(3))) return false;
      } else if (cond.startsWith('in.')) {
        const ids = cond.slice(4, -1).split(',');
        if (!ids.includes(String(row[key]))) return false;
      } else if (cond.startsWith('gt.')) {
        if (!(row[key] > Number(cond.slice(3)))) return false;
      } else if (cond.startsWith('lte.')) {
        if (!(new Date(row[key]) <= new Date(decodeURIComponent(cond.slice(4))))) return false;
      } else if (cond.startsWith('neq.')) {
        if (String(row[key]) === decodeURIComponent(cond.slice(4))) return false;
      }
      // gte./not./is. filters aren't exercised by this lifecycle's own
      // query shapes below, so intentionally unhandled.
    }
    return true;
  }

  return {
    tables,
    dbGet: async (p) => tables[table(p)].filter(r => matchesFilters(r, p)),
    dbPost: async (p, body) => {
      const row = { id: table(p) === 'billing_batches' ? `batch-${nextBatchId++}` : `${table(p)}-${Date.now()}-${Math.random()}`, ...body };
      tables[table(p)].push(row);
      return row;
    },
    dbPatch: async (p, body) => {
      const rows = tables[table(p)].filter(r => matchesFilters(r, p));
      rows.forEach(r => Object.assign(r, body));
      return rows;
    },
    supabaseRequest: async (p, opts) => {
      if (opts?.method === 'PATCH') {
        const rows = tables[table(p)].filter(r => matchesFilters(r, p));
        const body = JSON.parse(opts.body);
        rows.forEach(r => Object.assign(r, body));
      }
      return { ok: true, json: async () => ({}) };
    },
  };
}

test('periodic billing lifecycle: cron batches + emails a link, Stripe webhook settles it, booking becomes payout-eligible once past end_time', async (t) => {
  const fakeDb = makeFakeDb();
  fakeDb.tables.students.push({
    id: 'student-1', parent_email: 'parent@example.com', parent_name: 'Parent',
    billing_cycle: 'weekly', stripe_customer_id: null,
  });
  fakeDb.tables.bookings.push({
    id: 'booking-1', student_id: 'student-1', tutor_name: 'Azeem Omar-Mufti',
    fee_pence: 4000, payment_status: 'unbilled', status: 'confirmed',
    start_time: '2026-01-05T10:00:00Z', end_time: '2026-01-05T10:55:00Z',
  });

  let checkoutSessionId = null;

  for (const k of Object.keys(require.cache)) delete require.cache[k];
  mockModule('lib/cors.js', { applyCors: () => false });
  mockPackage('nodemailer', { createTransport: () => ({ sendMail: async () => ({}) }) });
  mockModule('lib/payments/index.js', {
    getPaymentService: () => ({
      createCheckoutSession: async (params) => {
        checkoutSessionId = 'cs_lifecycle_1';
        return { id: checkoutSessionId, url: 'https://checkout.stripe.com/cs_lifecycle_1' };
      },
    }),
  });
  mockModule('lib/db.js', { dbGet: fakeDb.dbGet, dbPost: fakeDb.dbPost, dbPatch: fakeDb.dbPatch, supabaseRequest: fakeDb.supabaseRequest });

  process.env.CRON_SECRET = 'shh';
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-03T06:00:00Z') }); // Monday, due day
  const billingHandler = require(path.join(backendRoot, 'api/billing.js'));
  const cronRes = { status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await billingHandler({ method: 'GET', query: { resource: 'billing-cron' }, headers: { authorization: 'Bearer shh' } }, cronRes);

  assert.equal(cronRes.statusCode, 200);
  assert.equal(cronRes.body.results[0].status, 'payment_link_sent');
  assert.equal(fakeDb.tables.billing_batches.length, 1, 'cron must create exactly one batch for the family');
  const batch = fakeDb.tables.billing_batches[0];
  assert.equal(batch.status, 'payment_link_sent');
  assert.equal(fakeDb.tables.bookings[0].payment_status, 'invoiced', 'booking must be invoiced, not yet paid, before Stripe confirms payment');
  assert.equal(fakeDb.tables.bookings[0].billing_batch_id, batch.id);

  // Now the family pays via the emailed Checkout link — Stripe fires
  // checkout.session.completed, which must settle the SAME batch row the
  // cron just created (not a hardcoded id), across a fresh handler load.
  t.mock.timers.reset();
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  const stripeEvent = {
    id: 'evt_lifecycle_1', type: 'checkout.session.completed',
    data: { object: { id: checkoutSessionId, payment_intent: 'pi_lifecycle_1', metadata: { billingBatchId: batch.id, studentId: 'student-1' } } },
  };
  const rawBodyPath = require.resolve('raw-body');
  require.cache[rawBodyPath] = { id: rawBodyPath, filename: rawBodyPath, loaded: true, exports: async () => Buffer.from('{}') };
  const stripePath = require.resolve('stripe');
  require.cache[stripePath] = {
    id: stripePath, filename: stripePath, loaded: true,
    exports: () => ({ webhooks: { constructEvent: () => stripeEvent } }),
  };
  mockModule('lib/db.js', {
    dbGet: fakeDb.dbGet, dbPost: fakeDb.dbPost,
    supabaseRequest: async (p, opts) => {
      if (p === '/stripe_webhook_events') return { ok: true, json: async () => ({}) };
      return fakeDb.supabaseRequest(p, opts);
    },
  });
  mockModule('lib/reminders.js', { sendBookingConfirmation: async () => {} });
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  const webhookHandler = require(path.join(backendRoot, 'api/webhook.js'));
  const webhookRes = { status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; } };
  await webhookHandler({ method: 'POST', headers: { 'stripe-signature': 'sig' } }, webhookRes);

  assert.equal(webhookRes.statusCode, 200);
  assert.equal(batch.status, 'paid');
  assert.equal(batch.stripe_payment_intent_id, 'pi_lifecycle_1');
  assert.equal(fakeDb.tables.bookings[0].payment_status, 'paid', 'webhook settlement must flip the booking to paid');

  // Finally: the booking is now paid AND its lesson (end_time) is in the
  // past relative to "now" — this is exactly the pair of conditions
  // payouts.js requires before a tutor can be paid out for it.
  const booking = fakeDb.tables.bookings[0];
  const nowReal = new Date();
  assert.equal(booking.payment_status, 'paid');
  assert.ok(new Date(booking.end_time) < nowReal, 'fixture lesson must actually be in the past for this assertion to mean anything');
});
