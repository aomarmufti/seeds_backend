const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWithMocks, makeRes } = require('./helpers/loadWithMocks');

// SCRUM-25 (tutor Resources panel) / SCRUM-24 (Group Sessions recordings),
// descoped to a pasted link (Google Drive/OneDrive/Zoom recording) rather
// than real file storage — one shared `resources` table/resource covers
// both, distinguished by `type`.

const tutorCaller = { id: 'tutor-1', role: 'tutor', email: 'tutor@example.com' };
const parentCaller = { id: 'parent-1', role: 'student', email: 'parent@example.com' };

test('resource=materials GET by tutorName requires that tutor\'s identity', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: { dbGet: async (path) => path.startsWith('/profiles?id=eq.') ? [{ tutor_name: 'Someone Else' }] : [] },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'materials', tutorName: 'Azeem Omar-Mufti' } }, res);
  assert.equal(res.statusCode, 403);
});

test('resource=materials GET by tutorName returns the tutor\'s own materials', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: {
      dbGet: async (path) => {
        if (path.startsWith('/profiles?id=eq.')) return [{ tutor_name: 'Azeem Omar-Mufti' }];
        if (path.startsWith('/resources?tutor_name=eq.')) return [{ id: 'r1', title: 'Past papers', url: 'https://drive.google.com/x' }];
        return [];
      },
    },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'materials', tutorName: 'Azeem Omar-Mufti' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.length, 1);
});

test('resource=materials GET by studentId rejects an unrelated caller', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => parentCaller },
    db: {
      dbGet: async (path) => {
        if (path.startsWith('/students?id=eq.')) return [{ parent_email: 'someone-else@example.com' }];
        if (path.startsWith('/profiles?id=eq.')) return [{ tutor_name: null }];
        return [];
      },
    },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'materials', studentId: 'student-1' } }, res);
  assert.equal(res.statusCode, 403);
});

test('resource=materials GET by studentId returns materials for the student\'s parent, including shared-with-all entries', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => parentCaller },
    db: {
      dbGet: async (path) => {
        if (path.startsWith('/students?id=eq.')) return [{ parent_email: 'parent@example.com' }];
        if (path.startsWith('/resources?or=')) return [{ id: 'r1', title: 'Group session recording', url: 'https://zoom.us/rec/x', type: 'recording' }];
        return [];
      },
    },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'materials', studentId: 'student-1', type: 'recording' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.length, 1);
});

test('resource=materials POST rejects a tutor adding a resource for a student they don\'t teach', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: {
      dbGet: async (path) => {
        if (path.startsWith('/profiles?id=eq.')) return [{ tutor_name: 'Azeem Omar-Mufti' }];
        if (path.startsWith('/bookings?student_id=eq.')) return [];
        return [];
      },
    },
  });
  const res = makeRes();
  await handler({
    method: 'POST', query: { resource: 'materials' },
    body: { tutorName: 'Azeem Omar-Mufti', studentId: 'student-1', title: 'Past papers', url: 'https://drive.google.com/x' },
  }, res);
  assert.equal(res.statusCode, 403);
});

test('resource=materials POST creates a resource for a real student of that tutor', async () => {
  let posted;
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: {
      dbGet: async (path) => {
        if (path.startsWith('/profiles?id=eq.')) return [{ tutor_name: 'Azeem Omar-Mufti' }];
        if (path.startsWith('/bookings?student_id=eq.')) return [{ id: 'b1' }];
        return [];
      },
      dbPost: async (path, body) => { posted = body; return { id: 'r1', ...body }; },
    },
  });
  const res = makeRes();
  await handler({
    method: 'POST', query: { resource: 'materials' },
    body: { tutorName: 'Azeem Omar-Mufti', studentId: 'student-1', subject: 'Maths', title: 'Past papers', url: 'https://drive.google.com/x' },
  }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(posted.type, 'resource');
  assert.equal(posted.student_id, 'student-1');
});

test('resource=materials POST allows sharing with all of a tutor\'s students (no studentId)', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: { dbGet: async (path) => path.startsWith('/profiles?id=eq.') ? [{ tutor_name: 'Azeem Omar-Mufti' }] : [] },
  });
  const res = makeRes();
  await handler({
    method: 'POST', query: { resource: 'materials' },
    body: { tutorName: 'Azeem Omar-Mufti', type: 'recording', title: 'Group session recording', url: 'https://zoom.us/rec/x' },
  }, res);
  assert.equal(res.statusCode, 201);
});

test('resource=materials DELETE rejects a tutor deleting someone else\'s entry', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => tutorCaller },
    db: { dbGet: async (path) => path.startsWith('/profiles?id=eq.') ? [{ tutor_name: 'Someone Else' }] : [] },
  });
  const res = makeRes();
  await handler({ method: 'DELETE', query: { resource: 'materials', id: 'r1', tutorName: 'Azeem Omar-Mufti' } }, res);
  assert.equal(res.statusCode, 403);
});

test('resource=materials requires authentication', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async (req, res) => { res.status(401).json({ error: 'Unauthorized' }); return null; } },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'materials', tutorName: 'Azeem Omar-Mufti' } }, res);
  assert.equal(res.statusCode, 401);
});
