// SCRUM-94: a free trial is used up by teaching received, not by a row
// existing. The old unique index keyed off `status <> 'cancelled'`, and
// recording a student no-show sets status = 'completed' — so a family lost
// their one free trial to a lesson they never got.
//
// The database now enforces "one consumed trial" and "one open trial"
// separately. Neither can express "you already had yours, so you may not book
// another", because that means reading other rows at insert time — that lives
// in lib/trialEligibility.js and is what these cover.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { trialConsumed, CONSUMED_OUTCOMES } = require('../lib/trialEligibility');
const { loadWithMocks, makeRes } = require('./helpers/loadWithMocks');

// The rule in one line: teaching received, not attendance attempted.
test('only delivered and partial count as consuming the trial', () => {
  assert.deepEqual(CONSUMED_OUTCOMES, ['delivered', 'partial']);
  for (const notConsumed of ['no_show', 'late_cancelled', 'waived', 'cancelled_mutual', 'tutor_cancelled']) {
    assert.ok(!CONSUMED_OUTCOMES.includes(notConsumed), `${notConsumed} must not burn a trial`);
  }
});

test('trialConsumed asks the database only for outcomes that consume', async () => {
  let asked;
  await trialConsumed(async (p) => { asked = p; return []; }, 'stu-1');
  assert.match(asked, /lesson_type=eq\.trial/);
  assert.match(asked, /delivery_status=in\.\(delivered,partial\)/);
  assert.match(asked, /student_id=eq\.stu-1/);
});

test('trialConsumed reports the booking that used it up', async () => {
  const { consumed, booking } = await trialConsumed(
    async () => [{ id: 'b1', start_time: '2026-05-01T10:00:00Z', delivery_status: 'delivered' }],
    'stu-1',
  );
  assert.equal(consumed, true);
  assert.equal(booking.start_time, '2026-05-01T10:00:00Z');
});

test('a student with no student_id is not treated as having consumed one', async () => {
  const { consumed } = await trialConsumed(async () => { throw new Error('should not query'); }, null);
  assert.equal(consumed, false);
});

// ── The behaviour a family actually experiences ────────────────────────────

const tutorCaller = { id: 'tutor-1', role: 'tutor', email: 'tutor@example.com' };

function lifecycleWith({ consumedTrial }) {
  return {
    auth: { requireAuth: async () => tutorCaller },
    db: {
      dbGet: async (path) => {
        if (path.startsWith('/enrolments?id=eq.')) return [{ id: 'enrol-1', student_id: 'student-1', tutor_id: 'tutor-1', subject: 'Maths', level: 'GCSE', rate_pence: 0, status: 'active' }];
        if (path.startsWith('/profiles?id=eq.')) return [{ tutor_id: 'tutor-1' }];
        if (path.startsWith('/tutors?id=eq.')) return [{ name: 'Azeem Omar-Mufti' }];
        // The eligibility lookup — only ever asks for consuming outcomes.
        if (path.includes('lesson_type=eq.trial') && path.includes('delivery_status=in.')) {
          return consumedTrial ? [{ id: 'old-trial', start_time: '2026-05-01T10:00:00Z' }] : [];
        }
        return [];
      },
      dbPost: async () => ({ id: 'b1' }),
    },
  };
}

function bookTrial() {
  return {
    method: 'POST', query: { resource: 'lessons' },
    body: { enrolmentId: 'enrol-1', lessonType: 'trial', startTime: new Date(Date.now() + 86400000).toISOString() },
  };
}

// The bug, from the family's side.
test('a student whose trial was no-showed can book another one', async () => {
  const handler = loadWithMocks('api/lifecycle.js', lifecycleWith({ consumedTrial: false }));
  const res = makeRes();
  await handler(bookTrial(), res);
  assert.equal(res.statusCode, 201);
});

test('a student whose trial was actually taught cannot book another', async () => {
  const handler = loadWithMocks('api/lifecycle.js', lifecycleWith({ consumedTrial: true }));
  const res = makeRes();
  await handler(bookTrial(), res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /already had their free trial/i);
  // Says when, so the family can be told rather than just refused.
  assert.equal(res.body.trialTakenOn, '2026-05-01T10:00:00Z');
});

// Refusing at insert time is the point: left to the index, the second trial
// would be created and would then refuse to be marked delivered, stranding a
// tutor who had just taught it.
test('a consumed trial is refused before anything is written', async () => {
  let posted = false;
  const mocks = lifecycleWith({ consumedTrial: true });
  mocks.db.dbPost = async () => { posted = true; return { id: 'b1' }; };
  const handler = loadWithMocks('api/lifecycle.js', mocks);
  const res = makeRes();
  await handler(bookTrial(), res);
  assert.equal(res.statusCode, 409);
  assert.equal(posted, false);
});

// A paid lesson is not a trial and must not be caught by any of this.
test('booking a paid lesson never consults trial eligibility', async () => {
  let askedEligibility = false;
  const mocks = lifecycleWith({ consumedTrial: true });
  const inner = mocks.db.dbGet;
  mocks.db.dbGet = async (path) => {
    if (path.includes('delivery_status=in.')) askedEligibility = true;
    return inner(path);
  };
  const handler = loadWithMocks('api/lifecycle.js', mocks);
  const res = makeRes();
  await handler({
    method: 'POST', query: { resource: 'lessons' },
    body: { enrolmentId: 'enrol-1', lessonType: 'gcse', startTime: new Date(Date.now() + 86400000).toISOString() },
  }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(askedEligibility, false);
});
