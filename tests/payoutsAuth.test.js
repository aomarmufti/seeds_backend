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

test('POST payouts create payout request rejects a caller requesting for a different tutor', async () => {
  const handler = loadWithMocks('api/payouts.js', {
    auth: { requireAuth: async () => otherTutorCaller },
    db: dbFor('Someone Else'),
  });
  const res = makeRes();
  await handler({ method: 'POST', body: { tutorName: 'Azeem Omar-Mufti', amountPence: 5000 } }, res);
  assert.equal(res.statusCode, 403);
});

test('POST payouts create payout request allows a tutor requesting their own payout', async () => {
  const handler = loadWithMocks('api/payouts.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: {
      dbGet: async (p) => (p.startsWith('/profiles?id=eq.') ? [{ tutor_name: 'Azeem Omar-Mufti' }] : []),
      dbPost: async (p, body) => ({ id: 'payout-1', ...body }),
    },
  });
  const res = makeRes();
  await handler({ method: 'POST', body: { tutorName: 'Azeem Omar-Mufti', amountPence: 5000 } }, res);
  assert.equal(res.statusCode, 201);
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
