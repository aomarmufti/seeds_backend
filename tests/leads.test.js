const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWithMocks, makeRes } = require('./helpers/loadWithMocks');

function selectSlotReq(overrides = {}) {
  return {
    method: 'POST',
    body: { action: 'select-slot', leadId: 'lead1', chosenSlot: new Date().toISOString(), ...overrides },
  };
}

function baseDb(extra = {}) {
  return {
    dbGet: async (p) => {
      if (p.startsWith('/leads?')) return [{ id: 'lead1', name: 'N', email: 'e@x.com', subject: 'Maths', level: 'gcse', assigned_tutor: 'Azeem' }];
      if (p.startsWith('/students?')) return [{ id: 'student1' }];
      if (p.startsWith('/profiles?')) return [];
      return [];
    },
    dbPost: async () => ({ id: 'x' }),
    supabaseRequest: async () => ({ ok: true, json: async () => ({}) }),
    ...extra,
  };
}

test('select-slot books the proposed slot for an existing student', async () => {
  const handler = loadWithMocks('api/leads.js', { db: baseDb() });
  const res = makeRes();
  await handler(selectSlotReq(), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.success, true);
});

test('select-slot returns 404 for an unknown lead', async () => {
  const handler = loadWithMocks('api/leads.js', { db: baseDb({ dbGet: async () => [] }) });
  const res = makeRes();
  await handler(selectSlotReq(), res);
  assert.equal(res.statusCode, 404);
});

test('select-slot returns a friendly 409 when the trial-limit constraint fires', async () => {
  const handler = loadWithMocks('api/leads.js', {
    db: baseDb({
      dbPost: async (p) => {
        if (p === '/bookings') throw new Error('duplicate key value violates unique constraint "bookings_one_trial_per_student"');
        return { id: 'x' };
      },
    }),
  });
  const res = makeRes();
  await handler(selectSlotReq(), res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /trial/);
});

test('select-slot returns a friendly 409 when the overlap constraint fires', async () => {
  const handler = loadWithMocks('api/leads.js', {
    db: baseDb({
      dbPost: async (p) => {
        if (p === '/bookings') throw new Error('conflicting key value violates exclusion constraint "bookings_no_tutor_overlap"');
        return { id: 'x' };
      },
    }),
  });
  const res = makeRes();
  await handler(selectSlotReq(), res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /taken/);
});

function createLeadReq(overrides = {}) {
  return {
    method: 'POST',
    body: { name: 'A Parent', email: 'parent@example.com', subject: 'Maths', level: 'gcse', ...overrides },
  };
}

test('creates a new lead', async () => {
  const handler = loadWithMocks('api/leads.js', {
    db: baseDb({ dbPost: async () => ({ id: 'lead1' }) }),
    reminders: { sendEnquiryConfirmation: async () => {}, sendAdminEnquiryAlert: async () => {} },
  });
  const res = makeRes();
  await handler(createLeadReq(), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.success, true);
});

test('lead creation rejects missing required fields', async () => {
  const handler = loadWithMocks('api/leads.js', { db: baseDb() });
  const res = makeRes();
  await handler(createLeadReq({ email: undefined }), res);
  assert.equal(res.statusCode, 400);
});

test('lead creation is rate-limited by IP (SCRUM-20)', async () => {
  const handler = loadWithMocks('api/leads.js', {
    db: baseDb({ dbRpc: async (fn, args) => !args.p_key.startsWith('leads-create:ip:') }),
  });
  const res = makeRes();
  await handler(createLeadReq(), res);
  assert.equal(res.statusCode, 429);
});

test('lead creation is rate-limited by email even under the IP limit (SCRUM-20)', async () => {
  const handler = loadWithMocks('api/leads.js', {
    db: baseDb({ dbRpc: async (fn, args) => !args.p_key.startsWith('leads-create:email:') }),
  });
  const res = makeRes();
  await handler(createLeadReq(), res);
  assert.equal(res.statusCode, 429);
});
