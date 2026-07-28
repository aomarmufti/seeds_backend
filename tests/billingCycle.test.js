const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const backendRoot = path.join(__dirname, '..');

function mockModule(relPath, exportsObj) {
  const resolved = require.resolve(path.join(backendRoot, relPath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

function loadHandler({ dbGetMock, dbPatchMock, callerEmail } = {}) {
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  mockModule('lib/cors.js', { applyCors: () => false });
  mockModule('lib/auth.js', {
    requireAuth: async () => ({ id: 'parent-1', role: 'student', email: callerEmail || 'parent@example.com' }),
  });
  mockModule('lib/payments/index.js', { getPaymentService: () => ({}) });
  mockModule('lib/db.js', {
    dbGet: dbGetMock || (async () => []),
    dbPatch: dbPatchMock || (async () => ({})),
    dbPost: async () => ({}),
    supabaseRequest: async () => ({ ok: true, json: async () => ({}) }),
  });
  return require(path.join(backendRoot, 'api/billing.js'));
}

function makeRes() {
  const res = {};
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('GET billing?resource=billing-cycle returns the caller\'s own billing_cycle', async () => {
  const handler = loadHandler({
    dbGetMock: async (p) => {
      assert.ok(p.includes('parent%40example.com'), 'looks up by the caller\'s own normalized email');
      return [{ billing_cycle: 'monthly' }];
    },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'billing-cycle' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.billingCycle, 'monthly');
});

test('GET billing?resource=billing-cycle defaults to weekly when the family has no student record yet', async () => {
  const handler = loadHandler({ dbGetMock: async () => [] });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'billing-cycle' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.billingCycle, 'weekly');
});

test('POST billing resource=billing-cycle lets a family switch to monthly billing', async () => {
  let patched = null;
  const handler = loadHandler({
    dbGetMock: async () => [{ id: 's1', parent_email: 'parent@example.com' }],
    dbPatchMock: async (p, body) => { patched = { p, body }; return {}; },
  });
  const res = makeRes();
  await handler({ method: 'POST', body: { resource: 'billing-cycle', billingCycle: 'monthly' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.billingCycle, 'monthly');
  assert.equal(patched.body.billing_cycle, 'monthly');
});

test('POST billing resource=billing-cycle rejects an invalid cadence', async () => {
  const handler = loadHandler();
  const res = makeRes();
  await handler({ method: 'POST', body: { resource: 'billing-cycle', billingCycle: 'daily' } }, res);
  assert.equal(res.statusCode, 400);
});

test('POST billing resource=billing-cycle 404s when the caller has no student record at all', async () => {
  const handler = loadHandler({ dbGetMock: async () => [] });
  const res = makeRes();
  await handler({ method: 'POST', body: { resource: 'billing-cycle', billingCycle: 'weekly' } }, res);
  assert.equal(res.statusCode, 404);
});

test('GET billing?resource=billing-history returns the caller\'s own billing batches', async () => {
  const handler = loadHandler({
    dbGetMock: async (p) => {
      if (p.startsWith('/students?parent_email=eq.')) return [{ id: 'student-1' }];
      if (p.startsWith('/billing_batches?student_id=in.')) {
        return [{ id: 'batch-1', cycle: 'weekly', period_start: '2026-07-01', period_end: '2026-07-08', total_pence: 8000, status: 'paid', payment_link: null, paid_at: '2026-07-08' }];
      }
      if (p.startsWith('/bookings?student_id=in.')) return [];
      return [];
    },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'billing-history' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.batches.length, 1);
  assert.equal(res.body.batches[0].totalPence, 8000);
  assert.equal(res.body.batches[0].status, 'paid');
});

// SCRUM-75: batches alone can't tell a family which specific lesson a
// weekly/monthly total covered — this is the per-lesson breakdown.
test('GET billing?resource=billing-history also returns a per-lesson breakdown', async () => {
  const handler = loadHandler({
    dbGetMock: async (p) => {
      if (p.startsWith('/students?parent_email=eq.')) return [{ id: 'student-1' }];
      if (p.startsWith('/billing_batches?student_id=in.')) return [];
      if (p.startsWith('/bookings?student_id=in.')) {
        assert.ok(p.includes('fee_pence=gt.0'), 'excludes free consultations/trials');
        // SCRUM-88: cancelled lessons are excluded EXCEPT late cancellations,
        // which are charged — a family must be able to see the lesson behind
        // a charge they'd otherwise read as a billing error.
        assert.ok(p.includes('or=(status.neq.cancelled,delivery_status.eq.late_cancelled)'));
        return [{
          id: 'b1', subject: 'Mathematics', tutor_name: 'Azeem Omar-Mufti', lesson_type: 'gcse',
          start_time: '2026-07-21T14:00:00Z', fee_pence: 4000, payment_status: 'paid', billing_batch_id: 'batch-1',
          delivery_status: 'delivered',
        }];
      }
      return [];
    },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'billing-history' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.lessons.length, 1);
  assert.deepEqual(res.body.lessons[0], {
    id: 'b1', subject: 'Mathematics', tutorName: 'Azeem Omar-Mufti', lessonType: 'gcse',
    startTime: '2026-07-21T14:00:00Z', feePence: 4000,
    paymentStatus: 'paid', billingBatchId: 'batch-1', deliveryStatus: 'delivered',
  });
});

test('GET billing?resource=billing-history returns an empty list for a family with no student record', async () => {
  const handler = loadHandler({ dbGetMock: async () => [] });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'billing-history' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.batches, []);
  assert.deepEqual(res.body.lessons, []);
});
