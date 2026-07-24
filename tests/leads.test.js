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

// ── GET auth scoping (SCRUM-13) ───────────────────────────────────────────
// Previously GET/PATCH had zero auth at all: anyone could dump every
// prospective family's PII, or rewrite any lead's status/tutor assignment.

test('GET leads requires authentication', async () => {
  const handler = loadWithMocks('api/leads.js', {
    auth: { requireAuth: async (req, res) => { res.status(401).json({ error: 'Unauthorized' }); return null; } },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: {} }, res);
  assert.equal(res.statusCode, 401);
});

test('GET leads rejects a non-admin caller looking up someone else\'s email', async () => {
  const handler = loadWithMocks('api/leads.js', {
    auth: { requireAuth: async () => ({ id: 'parent-1', role: 'student', email: 'me@example.com' }) },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { email: 'someone-else@example.com' } }, res);
  assert.equal(res.statusCode, 403);
});

test('GET leads allows a non-admin caller looking up their own email', async () => {
  const handler = loadWithMocks('api/leads.js', {
    auth: { requireAuth: async () => ({ id: 'parent-1', role: 'student', email: 'me@example.com' }) },
    db: { dbGet: async (p) => p.includes('email=eq.me%40example.com') ? [{ id: 'lead1' }] : [] },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { email: 'me@example.com' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.length, 1);
});

test('GET leads with no email scopes a tutor to their own assigned leads server-side', async () => {
  let queriedPath;
  const handler = loadWithMocks('api/leads.js', {
    auth: { requireAuth: async () => ({ id: 'tutor-1', role: 'tutor', email: 'tutor@example.com' }) },
    db: {
      dbGet: async (p) => {
        if (p.startsWith('/profiles?id=eq.')) return [{ tutor_name: 'Azeem Omar-Mufti' }];
        queriedPath = p;
        return [{ id: 'lead1' }];
      },
    },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.match(queriedPath, /assigned_tutor=eq\.Azeem/);
});

test('GET leads rejects a non-admin, non-tutor caller with no email filter', async () => {
  const handler = loadWithMocks('api/leads.js', {
    auth: { requireAuth: async () => ({ id: 'parent-1', role: 'student', email: 'me@example.com' }) },
    db: { dbGet: async () => [] },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: {} }, res);
  assert.equal(res.statusCode, 403);
});

// ── PATCH auth scoping (SCRUM-13) ─────────────────────────────────────────

test('PATCH leads requires authentication', async () => {
  const handler = loadWithMocks('api/leads.js', {
    auth: { requireAuth: async (req, res) => { res.status(401).json({ error: 'Unauthorized' }); return null; } },
  });
  const res = makeRes();
  await handler({ method: 'PATCH', body: { id: 'lead1', status: 'confirmed' } }, res);
  assert.equal(res.statusCode, 401);
});

test('PATCH leads rejects a tutor reassigning a lead to a different tutor', async () => {
  const handler = loadWithMocks('api/leads.js', {
    auth: { requireAuth: async () => ({ id: 'tutor-1', role: 'tutor', email: 'tutor@example.com' }) },
  });
  const res = makeRes();
  await handler({ method: 'PATCH', body: { id: 'lead1', assignedTutor: 'Someone Else' } }, res);
  assert.equal(res.statusCode, 403);
});

test('PATCH leads rejects a tutor updating a lead not assigned to them', async () => {
  const handler = loadWithMocks('api/leads.js', {
    auth: { requireAuth: async () => ({ id: 'tutor-1', role: 'tutor', email: 'tutor@example.com' }) },
    db: {
      dbGet: async (p) => {
        if (p.startsWith('/profiles?id=eq.')) return [{ tutor_name: 'Azeem Omar-Mufti' }];
        if (p.startsWith('/leads?id=eq.')) return [{ assigned_tutor: 'Someone Else' }];
        return [];
      },
    },
  });
  const res = makeRes();
  await handler({ method: 'PATCH', body: { id: 'lead1', status: 'confirmed' } }, res);
  assert.equal(res.statusCode, 403);
});

test('PATCH leads allows a tutor updating status/notes on their own assigned lead', async () => {
  const handler = loadWithMocks('api/leads.js', {
    auth: { requireAuth: async () => ({ id: 'tutor-1', role: 'tutor', email: 'tutor@example.com' }) },
    db: {
      dbGet: async (p) => {
        if (p.startsWith('/profiles?id=eq.')) return [{ tutor_name: 'Azeem Omar-Mufti' }];
        if (p.startsWith('/leads?id=eq.')) return [{ assigned_tutor: 'Azeem Omar-Mufti' }];
        return [];
      },
      supabaseRequest: async () => ({ ok: true, json: async () => ([{ id: 'lead1', name: 'N', email: 'e@x.com' }]) }),
    },
  });
  const res = makeRes();
  await handler({ method: 'PATCH', body: { id: 'lead1', status: 'confirmed' } }, res);
  assert.equal(res.statusCode, 200);
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
