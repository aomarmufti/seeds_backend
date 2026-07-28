const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWithMocks, makeRes } = require('./helpers/loadWithMocks');

// SCRUM-13: api/payouts.js had zero auth on everything except
// approve-and-transfer — including create-connect-account, which could
// point a tutor's future payouts at an arbitrary caller-supplied Stripe
// account with no verification at all.

const tutorCaller = { id: 'tutor-1', role: 'tutor', email: 'tutor@example.com' };
const otherTutorCaller = { id: 'tutor-2', role: 'tutor', email: 'other@example.com' };

function dbFor(tutorName) {
  return {
    dbGet: async (p) => (p.startsWith('/profiles?id=eq.') ? [{ tutor_name: tutorName }] : []),
  };
}

test('GET payouts requires authentication', async () => {
  const handler = loadWithMocks('api/payouts.js', {
    auth: { requireAuth: async (req, res) => { res.status(401).json({ error: 'Unauthorized' }); return null; } },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: {} }, res);
  assert.equal(res.statusCode, 401);
});

test('GET payouts with no tutor filter requires admin', async () => {
  const handler = loadWithMocks('api/payouts.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: dbFor('Azeem Omar-Mufti'),
  });
  const res = makeRes();
  await handler({ method: 'GET', query: {} }, res);
  assert.equal(res.statusCode, 403);
});

test('GET payouts rejects a tutor requesting someone else\'s payouts', async () => {
  const handler = loadWithMocks('api/payouts.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: dbFor('Azeem Omar-Mufti'),
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { tutor: 'Someone Else' } }, res);
  assert.equal(res.statusCode, 403);
});

test('GET payouts allows a tutor requesting their own payouts', async () => {
  const handler = loadWithMocks('api/payouts.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: { dbGet: async (p) => {
      if (p.startsWith('/profiles?id=eq.')) return [{ tutor_name: 'Azeem Omar-Mufti' }];
      if (p.startsWith('/payouts?')) return [{ id: 'p1' }];
      return [];
    } },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { tutor: 'Azeem Omar-Mufti' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.length, 1);
});

test('GET payouts resource=verify rejects a tutor querying another tutor\'s earnings', async () => {
  const handler = loadWithMocks('api/payouts.js', {
    auth: { requireAuth: async () => otherTutorCaller },
    db: dbFor('Someone Else'),
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'verify', tutor: 'Azeem Omar-Mufti' } }, res);
  assert.equal(res.statusCode, 403);
});

test('POST payouts create-connect-account requires authentication', async () => {
  const handler = loadWithMocks('api/payouts.js', {
    auth: { requireAuth: async (req, res) => { res.status(401).json({ error: 'Unauthorized' }); return null; } },
  });
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'create-connect-account', tutorName: 'Azeem Omar-Mufti' } }, res);
  assert.equal(res.statusCode, 401);
});

test('POST payouts create-connect-account rejects a caller impersonating a different tutor', async () => {
  const handler = loadWithMocks('api/payouts.js', {
    auth: { requireAuth: async () => otherTutorCaller },
    db: dbFor('Someone Else'),
  });
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'create-connect-account', tutorName: 'Azeem Omar-Mufti' } }, res);
  assert.equal(res.statusCode, 403);
});

// SCRUM-76: self-serve "request a payout" was removed — payouts are now
// automatic (weekly/monthly, admin-set per tutor). A POST with no
// recognised action (the old request-payout shape) is just rejected.
test('POST payouts with no action and no known resource is rejected', async () => {
  const handler = loadWithMocks('api/payouts.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: dbFor('Azeem Omar-Mufti'),
  });
  const res = makeRes();
  await handler({ method: 'POST', body: { tutorName: 'Azeem Omar-Mufti', amountPence: 5000 } }, res);
  assert.equal(res.statusCode, 400);
});

test('POST payouts set-payout-cycle requires admin', async () => {
  const handler = loadWithMocks('api/payouts.js', {
    auth: { requireAdmin: async (req, res) => { res.status(401).json({ error: 'Unauthorized' }); return null; } },
  });
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'set-payout-cycle', tutorName: 'Azeem Omar-Mufti', payoutCycle: 'monthly' } }, res);
  assert.equal(res.statusCode, 401);
});

test('POST payouts set-payout-cycle rejects a cadence that isn\'t weekly or monthly', async () => {
  const handler = loadWithMocks('api/payouts.js');
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'set-payout-cycle', tutorName: 'Azeem Omar-Mufti', payoutCycle: 'daily' } }, res);
  assert.equal(res.statusCode, 400);
});

test('POST payouts set-payout-cycle upserts the tutor\'s cycle by name', async () => {
  let upserted = null;
  const handler = loadWithMocks('api/payouts.js', {
    db: {
      supabaseRequest: async (p, opts) => {
        upserted = { path: p, body: JSON.parse(opts.body), prefer: opts.prefer };
        return { ok: true, json: async () => ({}) };
      },
    },
  });
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'set-payout-cycle', tutorName: 'Suleiman', payoutCycle: 'monthly' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(upserted.path, '/tutor_accounts?on_conflict=tutor_name');
  assert.deepEqual(upserted.body, { tutor_name: 'Suleiman', payout_cycle: 'monthly' });
  assert.match(upserted.prefer, /merge-duplicates/);
});

test('POST payouts approve-and-transfer is unaffected — still admin-gated as before', async () => {
  const handler = loadWithMocks('api/payouts.js', {
    auth: {
      requireAuth: async () => tutorCaller,
      requireAdmin: async (req, res) => { res.status(401).json({ error: 'Unauthorized' }); return null; },
    },
  });
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'approve-and-transfer', tutorName: 'Azeem Omar-Mufti', amountPence: 10000 } }, res);
  assert.equal(res.statusCode, 401);
});

// Periodic billing means a booking's own status is 'confirmed' the moment
// it's made, regardless of whether the family has actually been charged
// yet — so marking a booking "tutor paid out" (status -> 'completed') must
// also require payment_status='paid', or an admin could pay a tutor out of
// money that was never actually collected from the family.
test('POST payouts approve-and-transfer only completes bookings the student has actually paid for', async () => {
  let queriedPath;
  const handler = loadWithMocks('api/payouts.js', {
    auth: { requireAdmin: async () => ({ id: 'admin-1', email: 'admin@example.com', role: 'admin' }) },
    db: {
      supabaseRequest: async (p) => {
        if (p.startsWith('/bookings?')) queriedPath = p;
        return { ok: true, json: async () => ({}) };
      },
      dbGet: async () => [],
    },
  });
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'approve-and-transfer', tutorName: 'Azeem Omar-Mufti', amountPence: 10000 } }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(queriedPath.includes('status=eq.confirmed'));
  assert.ok(queriedPath.includes('payment_status=eq.paid'), 'must not complete a booking the family has not paid for yet');
  assert.ok(queriedPath.includes('end_time=lte.'), 'must not complete a booking for a lesson that hasn\'t happened yet');
});
