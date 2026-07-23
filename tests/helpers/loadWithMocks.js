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

function loadWithMocks(apiRelPath, { db, reminders, cors, pricing, auth, validate, tutors, calendly } = {}) {
  for (const k of Object.keys(require.cache)) delete require.cache[k];

  mockModule('lib/db.js', {
    dbGet: async () => [],
    dbPost: async () => ({}),
    dbPatch: async () => ({}),
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
  mockModule('lib/pricing.js', {
    resolvePrice: () => ({ duration: 55, amount: 4000 }),
    ...pricing,
  });
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
    ...validate,
  });
  mockModule('lib/tutors.js', {
    getMeetingLink: async () => 'https://meet.google.com/seeds-tuition',
    registerTutor: async () => {},
    ...tutors,
  });
  mockModule('lib/calendly.js', {
    createSchedulingLink: async () => 'https://calendly.com/seeds-tuition/lesson',
    verifyWebhookSignature: () => {},
    parseInviteeCreatedPayload: () => ({}),
    getScheduledEvent: async () => ({ startTime: new Date().toISOString(), endTime: new Date().toISOString() }),
    ...calendly,
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
