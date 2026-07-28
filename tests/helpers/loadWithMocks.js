// Loads an api/*.js handler with its lib/* dependencies replaced by mocks,
// since there's no live Supabase/Stripe/browser available for these tests.
// Clears the require cache first so each test gets a fresh handler bound
// to its own mocks rather than a previous test's.
const path = require('path');

const backendRoot = path.join(__dirname, '..', '..');

function mockModule(relPath, exportsObj) {
  const resolved = require.resolve(path.join(backendRoot, relPath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// For real npm packages (resolved by name, not relative to backendRoot) —
// several api/*.js handlers call nodemailer directly rather than through
// lib/reminders.js, so without this any test reaching those code paths
// attempts a real SMTP connection and hangs against this sandbox's network
// restrictions instead of failing fast.
function mockPackage(pkgName, exportsObj) {
  const resolved = require.resolve(pkgName);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

function loadWithMocks(apiRelPath, { db, reminders, cors, pricing, auth, validate, tutors, cal, nodemailer, payments } = {}) {
  for (const k of Object.keys(require.cache)) delete require.cache[k];

  mockPackage('nodemailer', {
    createTransport: () => ({ sendMail: async () => ({}) }),
    ...nodemailer,
  });

  mockModule('lib/db.js', {
    dbGet: async () => [],
    dbPost: async () => ({}),
    dbPatch: async () => ({}),
    dbRpc: async () => true,
    supabaseRequest: async () => ({ ok: true, json: async () => ({}) }),
    supabaseAdminRequest: async () => ({ ok: true, json: async () => ({ id: 'user-1' }) }),
    ...db,
  });
  mockModule('lib/reminders.js', {
    sendBookingConfirmation: async () => {},
    sendLessonReminder: async () => {},
    sendSlotBookedToTutor: async () => {},
    ...reminders,
  });
  mockModule('lib/cors.js', { applyCors: () => false, ...cors });
  // Real pricing by default. It's pure logic with no external dependency,
  // and stubbing it to a flat £40 hid a live bug where a free consultation
  // was charged £40 — exactly the thing these tests should catch. Pass
  // pricing:{resolvePrice:...} to override for a specific test.
  const realPricing = require(path.join(backendRoot, 'lib/pricing.js'));
  mockModule('lib/pricing.js', { ...realPricing, ...pricing });
  // Default: caller is an authenticated admin, so tests exercise the
  // handler's own logic rather than the auth gate. Pass auth:{requireAdmin:...}
  // to test the unauthorized path specifically.
  mockModule('lib/auth.js', {
    requireAdmin: async () => ({ id: 'admin-1', role: 'admin' }),
    requireAuth: async () => ({ id: 'admin-1', role: 'admin', email: 'admin@example.com' }),
    getAuthedUser: async () => ({ id: 'admin-1', role: 'admin', email: 'admin@example.com' }),
    ...auth,
  });
  // Default: any id "looks valid" so tests can use readable fixture ids
  // like 'lead1' instead of real UUIDs.
  mockModule('lib/validate.js', {
    isValidId: () => true,
    normalizeEmail: (email) => (email || '').trim().toLowerCase(),
    ...validate,
  });
  mockModule('lib/tutors.js', {
    getMeetingLink: async () => 'https://meet.google.com/seeds-tuition',
    registerTutor: async () => {},
    ...tutors,
  });
  mockModule('lib/cal.js', {
    verifyWebhookSignature: () => {},
    parseBookingPayload: () => ({}),
    ...cal,
  });
  // Default: a refund/charge that just succeeds, so tests exercising a
  // paid-booking code path don't need real Stripe config. Pass
  // payments:{createRefund:...} (etc.) to assert on the actual call.
  mockModule('lib/payments/index.js', {
    getPaymentService: () => ({
      createRefund: async () => ({ id: 're_test' }),
      ...payments,
    }),
  });

  return require(path.join(backendRoot, apiRelPath));
}

function makeRes() {
  const res = {};
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

module.exports = { loadWithMocks, makeRes };
