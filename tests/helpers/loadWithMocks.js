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

function loadWithMocks(apiRelPath, { db, reminders, cors, pricing } = {}) {
  for (const k of Object.keys(require.cache)) delete require.cache[k];

  mockModule('lib/db.js', {
    dbGet: async () => [],
    dbPost: async () => ({}),
    dbPatch: async () => ({}),
    supabaseRequest: async () => ({ ok: true, json: async () => ({}) }),
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

  return require(path.join(backendRoot, apiRelPath));
}

function makeRes() {
  const res = {};
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

module.exports = { loadWithMocks, makeRes };
