// api/enrolments.js — who may write what.
//
// The permission model is the whole point of this table: rate and tutor are
// commercial facts, and the design rule is that the student asks, the tutor
// teaches, and the admin decides. These assert the boundary rather than the
// happy path, because the boundary is what was wrong.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWithMocks, makeRes } = require('./helpers/loadWithMocks');

const ENROLMENT_ID = '22222222-2222-2222-2222-222222222222';

const familyCaller = { id: 'parent-1', role: 'student', email: 'parent@example.com' };
const adminCaller = { id: 'admin-1', role: 'admin', email: 'admin@example.com' };

function dbForFamily({ patched } = {}) {
  return {
    dbGet: async (p) => {
      if (p.startsWith('/enrolments?id=eq.')) return [{ id: ENROLMENT_ID, student_id: 'stu-1', status: 'active', rate_pence: 4000 }];
      if (p.startsWith('/students?parent_email=eq.')) return [{ id: 'stu-1' }];
      if (p.startsWith('/students?id=eq.')) return [{ id: 'stu-1' }];
      if (p.startsWith('/tutors?id=eq.')) return [{ id: 'tut-1' }];
      return [];
    },
    dbPatch: async (path, body) => { patched?.push({ path, body }); return { id: ENROLMENT_ID, ...body }; },
    dbPost: async (path, body) => ({ id: 'new-1', ...body }),
  };
}

// ── The escalation this file exists for ────────────────────────────────────
// The role check validated `status` and then applied every field on the body
// regardless of who sent it. Omitting `status` skipped the only check there
// was, so a family could set its own price.

test('a family cannot set its own rate on its own enrolment', async () => {
  const patched = [];
  const handler = loadWithMocks('api/enrolments.js', {
    auth: { requireAuth: async () => familyCaller },
    db: dbForFamily({ patched }),
  });
  const res = makeRes();
  await handler({ method: 'PATCH', query: {}, body: { id: ENROLMENT_ID, rate_pence: 1 } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(patched.length, 0, 'nothing may be written');
});

test('a family cannot hand itself a tutor', async () => {
  const patched = [];
  const handler = loadWithMocks('api/enrolments.js', {
    auth: { requireAuth: async () => familyCaller },
    db: dbForFamily({ patched }),
  });
  const res = makeRes();
  await handler({ method: 'PATCH', query: {}, body: { id: ENROLMENT_ID, tutor_id: 'tut-1' } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(patched.length, 0);
});

test('a family smuggling rate alongside a legitimate pause is refused entirely', async () => {
  const patched = [];
  const handler = loadWithMocks('api/enrolments.js', {
    auth: { requireAuth: async () => familyCaller },
    db: dbForFamily({ patched }),
  });
  const res = makeRes();
  await handler({ method: 'PATCH', query: {}, body: { id: ENROLMENT_ID, status: 'paused', rate_pence: 1 } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(patched.length, 0, 'the valid half must not be applied either');
});

// ── What a family legitimately may do ──────────────────────────────────────

test('a family can pause its own enrolment', async () => {
  const patched = [];
  const handler = loadWithMocks('api/enrolments.js', {
    auth: { requireAuth: async () => familyCaller },
    db: dbForFamily({ patched }),
  });
  const res = makeRes();
  await handler({ method: 'PATCH', query: {}, body: { id: ENROLMENT_ID, status: 'paused' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(patched[0].body, { status: 'paused' });
});

test('ending an enrolment stamps ended_at server-side', async () => {
  const patched = [];
  const handler = loadWithMocks('api/enrolments.js', {
    auth: { requireAuth: async () => familyCaller },
    db: dbForFamily({ patched }),
  });
  const res = makeRes();
  await handler({ method: 'PATCH', query: {}, body: { id: ENROLMENT_ID, status: 'ended' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(patched[0].body.status, 'ended');
  assert.ok(patched[0].body.ended_at, 'ended_at is set for them');
});

test('a family cannot activate its own enrolment', async () => {
  const handler = loadWithMocks('api/enrolments.js', {
    auth: { requireAuth: async () => familyCaller },
    db: dbForFamily(),
  });
  const res = makeRes();
  await handler({ method: 'PATCH', query: {}, body: { id: ENROLMENT_ID, status: 'active' } }, res);
  assert.equal(res.statusCode, 400);
});

test('a family cannot touch another family\'s enrolment', async () => {
  const handler = loadWithMocks('api/enrolments.js', {
    auth: { requireAuth: async () => ({ id: 'parent-2', role: 'student', email: 'other@example.com' }) },
    db: {
      dbGet: async (p) => {
        if (p.startsWith('/enrolments?id=eq.')) return [{ id: ENROLMENT_ID, student_id: 'stu-1' }];
        if (p.startsWith('/students?parent_email=eq.')) return [{ id: 'stu-99' }];
        return [];
      },
    },
  });
  const res = makeRes();
  await handler({ method: 'PATCH', query: {}, body: { id: ENROLMENT_ID, status: 'paused' } }, res);
  assert.equal(res.statusCode, 403);
});

// An admin retains everything, which is what the restriction is relative to.
test('an admin can still set rate and tutor', async () => {
  const patched = [];
  const handler = loadWithMocks('api/enrolments.js', {
    auth: { requireAuth: async () => adminCaller },
    db: dbForFamily({ patched }),
  });
  const res = makeRes();
  await handler({ method: 'PATCH', query: {}, body: { id: ENROLMENT_ID, rate_pence: 5000, tutor_id: 'tut-1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(patched[0].body.rate_pence, 5000);
  assert.equal(patched[0].body.tutor_id, 'tut-1');
});

// ── Requesting a subject ───────────────────────────────────────────────────

test('a family can request a subject, and it lands as pending with no tutor', async () => {
  let posted;
  const handler = loadWithMocks('api/enrolments.js', {
    auth: { requireAuth: async () => familyCaller },
    db: {
      ...dbForFamily(),
      dbPost: async (path, body) => { posted = body; return { id: 'new-1', ...body }; },
    },
  });
  const res = makeRes();
  await handler({ method: 'POST', query: {}, body: { subject: 'Chemistry', level: 'GCSE' } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(posted.status, 'pending');
  assert.equal(posted.tutor_id, null);
  assert.equal(posted.student_id, 'stu-1', 'resolved from the login, not the body');
});

test('a subject request cannot name its own tutor or rate', async () => {
  const handler = loadWithMocks('api/enrolments.js', {
    auth: { requireAuth: async () => familyCaller },
    db: dbForFamily(),
  });
  const res = makeRes();
  await handler({ method: 'POST', query: {}, body: { subject: 'Chemistry', level: 'GCSE', tutor_id: 'tut-1' } }, res);
  assert.equal(res.statusCode, 403);
});

test('a subject request cannot create itself already active', async () => {
  const handler = loadWithMocks('api/enrolments.js', {
    auth: { requireAuth: async () => familyCaller },
    db: dbForFamily(),
  });
  const res = makeRes();
  await handler({ method: 'POST', query: {}, body: { subject: 'Chemistry', level: 'GCSE', status: 'active' } }, res);
  assert.equal(res.statusCode, 403);
});

test('a family cannot request an enrolment for another family', async () => {
  let posted;
  const handler = loadWithMocks('api/enrolments.js', {
    auth: { requireAuth: async () => familyCaller },
    db: {
      ...dbForFamily(),
      dbPost: async (path, body) => { posted = body; return { id: 'new-1', ...body }; },
    },
  });
  const res = makeRes();
  await handler({ method: 'POST', query: {}, body: { student_id: 'someone-else', subject: 'Chemistry', level: 'GCSE' } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(posted.student_id, 'stu-1', 'the body\'s student_id is ignored');
});

test('a tutor still cannot modify an enrolment', async () => {
  const handler = loadWithMocks('api/enrolments.js', {
    auth: { requireAuth: async () => ({ id: 'tutor-1', role: 'tutor', email: 'tutor@example.com' }) },
    db: dbForFamily(),
  });
  const res = makeRes();
  await handler({ method: 'PATCH', query: {}, body: { id: ENROLMENT_ID, status: 'ended' } }, res);
  assert.equal(res.statusCode, 403);
});
