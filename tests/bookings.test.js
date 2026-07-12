const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWithMocks, makeRes } = require('./helpers/loadWithMocks');

function confirmReq(overrides = {}) {
  return {
    query: { action: 'confirm' },
    body: {
      studentName: 'S', parentName: 'P', parentEmail: 'p@example.com',
      tutorName: 'Azeem', subject: 'Maths', lessonType: 'trial', studentLevel: 'gcse',
      startTime: new Date().toISOString(), paymentIntentId: 'pi_test',
      ...overrides,
    },
  };
}

test('confirm booking succeeds and creates a new student when none exists', async () => {
  const handler = loadWithMocks('api/bookings.js', {
    db: { dbGet: async () => [], dbPost: async (p) => (p === '/bookings' ? { id: 'b1' } : { id: 'student1' }) },
  });
  const res = makeRes();
  await handler(confirmReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
});

test('confirm booking reuses an existing student by parent email', async () => {
  let studentCreated = false;
  const handler = loadWithMocks('api/bookings.js', {
    db: {
      dbGet: async (p) => (p.startsWith('/students') ? [{ id: 'existing-student' }] : []),
      dbPost: async (p) => {
        if (p === '/students') studentCreated = true;
        return { id: 'b1' };
      },
    },
  });
  const res = makeRes();
  await handler(confirmReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(studentCreated, false, 'should not create a duplicate student record');
});

test('confirm booking returns a friendly 409 on tutor double-booking', async () => {
  const handler = loadWithMocks('api/bookings.js', {
    db: {
      dbGet: async () => [],
      dbPost: async (p) => {
        if (p === '/bookings') throw new Error('conflicting key value violates exclusion constraint "bookings_no_tutor_overlap"');
        return { id: 'student1' };
      },
    },
  });
  const res = makeRes();
  await handler(confirmReq(), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.conflict, true);
  assert.match(res.body.error, /Azeem/);
});

test('confirm booking returns a friendly 409 when the student already used their trial', async () => {
  const handler = loadWithMocks('api/bookings.js', {
    db: {
      dbGet: async () => [],
      dbPost: async (p) => {
        if (p === '/bookings') throw new Error('duplicate key value violates unique constraint "bookings_one_trial_per_student"');
        return { id: 'student1' };
      },
    },
  });
  const res = makeRes();
  await handler(confirmReq(), res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /trial/);
});

test('confirm booking rejects a request missing required fields', async () => {
  const handler = loadWithMocks('api/bookings.js');
  const res = makeRes();
  await handler(confirmReq({ tutorName: undefined }), res);
  assert.equal(res.statusCode, 400);
});

test('confirm booking pre-check catches an existing conflicting booking before insert', async () => {
  const handler = loadWithMocks('api/bookings.js', {
    db: {
      dbGet: async (p) => (p.startsWith('/bookings?tutor_name') ? [{ id: 'conflicting' }] : []),
    },
  });
  const res = makeRes();
  await handler(confirmReq(), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.conflict, true);
});
