const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const backendRoot = path.join(__dirname, '..');

function mockDb(dbRpc) {
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  const p = require.resolve(path.join(backendRoot, 'lib/db.js'));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: { dbRpc } };
}
function makeRes() {
  const res = {};
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('checkRateLimit returns whatever the RPC reports', async () => {
  mockDb(async (fn, args) => {
    assert.equal(fn, 'check_rate_limit');
    assert.deepEqual(args, { p_key: 'scope:ip:1.2.3.4', p_max: 5, p_window_seconds: 900 });
    return false;
  });
  const { checkRateLimit } = require(path.join(backendRoot, 'lib/rateLimit.js'));
  assert.equal(await checkRateLimit('scope:ip:1.2.3.4', 5, 900), false);
});

test('checkRateLimit fails open (allows the request) if the RPC errors', async () => {
  mockDb(async () => { throw new Error('db unreachable'); });
  const { checkRateLimit } = require(path.join(backendRoot, 'lib/rateLimit.js'));
  assert.equal(await checkRateLimit('scope:ip:1.2.3.4', 5, 900), true);
});

test('getClientIp reads the first entry of x-forwarded-for', () => {
  mockDb(async () => true);
  const { getClientIp } = require(path.join(backendRoot, 'lib/rateLimit.js'));
  assert.equal(getClientIp({ headers: { 'x-forwarded-for': '9.9.9.9, 1.1.1.1' } }), '9.9.9.9');
});

test('getClientIp falls back to socket.remoteAddress, then "unknown"', () => {
  mockDb(async () => true);
  const { getClientIp } = require(path.join(backendRoot, 'lib/rateLimit.js'));
  assert.equal(getClientIp({ headers: {}, socket: { remoteAddress: '5.5.5.5' } }), '5.5.5.5');
  assert.equal(getClientIp({ headers: {} }), 'unknown');
});

test('rateLimitOrReject sends 429 and returns false when over the limit', async () => {
  mockDb(async () => false);
  const { rateLimitOrReject } = require(path.join(backendRoot, 'lib/rateLimit.js'));
  const res = makeRes();
  const allowed = await rateLimitOrReject({ headers: {} }, res, 'scope', { max: 5, windowSeconds: 900 });
  assert.equal(allowed, false);
  assert.equal(res.statusCode, 429);
});

test('rateLimitOrReject returns true and touches nothing on res when under the limit', async () => {
  mockDb(async () => true);
  const { rateLimitOrReject } = require(path.join(backendRoot, 'lib/rateLimit.js'));
  const res = makeRes();
  const allowed = await rateLimitOrReject({ headers: {} }, res, 'scope', { max: 5, windowSeconds: 900 });
  assert.equal(allowed, true);
  assert.equal(res.statusCode, undefined);
});
