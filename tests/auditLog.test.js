const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const backendRoot = path.join(__dirname, '..');

function loadAuditLog(supabaseRequestMock) {
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  const dbPath = require.resolve(path.join(backendRoot, 'lib/db.js'));
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { supabaseRequest: supabaseRequestMock } };
  return require(path.join(backendRoot, 'lib/auditLog.js'));
}

test('posts the expected payload shape to admin_audit_log', async () => {
  let captured;
  const { logAdminAction } = loadAuditLog(async (path, opts) => {
    captured = { path, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({}) };
  });
  await logAdminAction({ actor: 'admin@example.com', action: 'bulk-cancel', targetType: 'booking', targetId: 'b1', details: { count: 3 } });
  assert.equal(captured.path, '/admin_audit_log');
  assert.equal(captured.body.actor, 'admin@example.com');
  assert.equal(captured.body.action, 'bulk-cancel');
  assert.equal(captured.body.target_id, 'b1');
  assert.deepEqual(captured.body.details, { count: 3 });
});

test('never throws when the write fails (best-effort logging)', async () => {
  const { logAdminAction } = loadAuditLog(async () => { throw new Error('network down'); });
  await assert.doesNotReject(logAdminAction({ actor: 'x', action: 'y' }));
});

test('never throws when supabase returns a non-ok response', async () => {
  const { logAdminAction } = loadAuditLog(async () => ({ ok: false, status: 500, json: async () => ({ message: 'boom' }) }));
  await assert.doesNotReject(logAdminAction({ actor: 'x', action: 'y' }));
});
