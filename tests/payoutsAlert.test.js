const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const backendRoot = path.join(__dirname, '..');

function mockModule(relPath, exportsObj) {
  const resolved = require.resolve(path.join(backendRoot, relPath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
function makeRes() {
  const res = {};
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('approve-and-transfer alerts the admin (and logs) when the Stripe transfer throws', async () => {
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  mockModule('lib/cors.js', { applyCors: () => false });
  mockModule('lib/auth.js', { requireAdmin: async () => ({ id: 'admin-1', email: 'admin@example.com' }) });
  mockModule('lib/auditLog.js', { logAdminAction: async () => {} });
  mockModule('lib/db.js', {
    dbGet: async () => [{ stripe_account_id: 'acct_1', onboarding_complete: true }],
    supabaseRequest: async () => ({ ok: true, json: async () => ({}) }),
  });
  const stripePath = require.resolve('stripe');
  require.cache[stripePath] = {
    id: stripePath, filename: stripePath, loaded: true,
    exports: () => ({ transfers: { create: async () => { throw new Error('Stripe transfer failed: insufficient balance'); } } }),
  };
  const alerts = [];
  mockModule('lib/logger.js', {
    logError: () => {},
    alertCritical: async (subject, details) => { alerts.push({ subject, details }); },
  });
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';

  const handler = require(path.join(backendRoot, 'api/payouts.js'));
  const res = makeRes();
  await handler({
    method: 'POST',
    body: { action: 'approve-and-transfer', tutorName: 'Azeem Omar-Mufti', amountPence: 10000 },
  }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].subject, /payout/i);
  assert.match(alerts[0].details, /Azeem Omar-Mufti/);
});
