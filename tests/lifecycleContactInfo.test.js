const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWithMocks, makeRes } = require('./helpers/loadWithMocks');

// SCRUM-55: parent<->tutor contact info (email always, WhatsApp opt-in only).
// The core requirement being tested here is the ownership check — a caller
// can only see contact info for a party they actually have a real booking
// with, not an arbitrary tutorName/studentId they pass in.

test('resource=contact-info requires authentication', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async (req, res) => { res.status(401).json({ error: 'Unauthorized' }); return null; } },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'contact-info', for: 'tutor', tutorName: 'Azeem Omar-Mufti' } }, res);
  assert.equal(res.statusCode, 401);
});

test('resource=contact-info for=tutor returns email always, whatsapp only when opted in', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => ({ id: 'parent-1', role: 'student', email: 'parent@example.com' }) },
    db: {
      dbGet: async (path) => {
        if (path.startsWith('/students?parent_email')) return [{ id: 's1' }];
        if (path.startsWith('/bookings')) return [{ id: 'b1' }];
        if (path.startsWith('/profiles')) return [{ email: 'tutor@example.com', whatsapp_number: '+447000000000', whatsapp_opted_in: true }];
        return [];
      },
    },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'contact-info', for: 'tutor', tutorName: 'Azeem Omar-Mufti' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { email: 'tutor@example.com', whatsappNumber: '+447000000000' });
});

test('resource=contact-info for=tutor hides whatsapp when the tutor has not opted in', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => ({ id: 'parent-1', role: 'student', email: 'parent@example.com' }) },
    db: {
      dbGet: async (path) => {
        if (path.startsWith('/students?parent_email')) return [{ id: 's1' }];
        if (path.startsWith('/bookings')) return [{ id: 'b1' }];
        if (path.startsWith('/profiles')) return [{ email: 'tutor@example.com', whatsapp_number: '+447000000000', whatsapp_opted_in: false }];
        return [];
      },
    },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'contact-info', for: 'tutor', tutorName: 'Azeem Omar-Mufti' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { email: 'tutor@example.com', whatsappNumber: null });
});

test('resource=contact-info for=tutor rejects a tutor the caller has no booking with', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => ({ id: 'parent-1', role: 'student', email: 'parent@example.com' }) },
    db: {
      dbGet: async (path) => {
        if (path.startsWith('/students?parent_email')) return [{ id: 's1' }];
        if (path.startsWith('/bookings')) return []; // no booking with this tutor
        return [];
      },
    },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'contact-info', for: 'tutor', tutorName: 'Someone Else' } }, res);
  assert.equal(res.statusCode, 403);
});

test('resource=contact-info for=tutor rejects a caller with no student record at all', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => ({ id: 'parent-1', role: 'student', email: 'nobody@example.com' }) },
    db: { dbGet: async () => [] },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'contact-info', for: 'tutor', tutorName: 'Azeem Omar-Mufti' } }, res);
  assert.equal(res.statusCode, 403);
});

test('resource=contact-info for=parent returns the student\'s parent email + opted-in whatsapp', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => ({ id: 'tutor-1', role: 'tutor', email: 'tutor@example.com' }) },
    db: {
      dbGet: async (path) => {
        if (path.includes('/profiles?id=eq.tutor-1')) return [{ tutor_name: 'Azeem Omar-Mufti' }];
        if (path.startsWith('/bookings')) return [{ id: 'b1' }];
        if (path.startsWith('/students')) return [{ parent_email: 'parent@example.com' }];
        if (path.includes('/profiles?email=eq.')) return [{ whatsapp_number: '+447111111111', whatsapp_opted_in: true }];
        return [];
      },
    },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'contact-info', for: 'parent', studentId: 'student-1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { email: 'parent@example.com', whatsappNumber: '+447111111111' });
});

test('resource=contact-info for=parent rejects a tutor with no bookings for that student', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => ({ id: 'tutor-1', role: 'tutor', email: 'tutor@example.com' }) },
    db: {
      dbGet: async (path) => {
        if (path.includes('/profiles?id=eq.tutor-1')) return [{ tutor_name: 'Azeem Omar-Mufti' }];
        if (path.startsWith('/bookings')) return []; // no booking with this student
        return [];
      },
    },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'contact-info', for: 'parent', studentId: 'student-1' } }, res);
  assert.equal(res.statusCode, 403);
});

test('resource=contact-info rejects an invalid "for" value', async () => {
  const handler = loadWithMocks('api/lifecycle.js', {
    auth: { requireAuth: async () => ({ id: 'x', role: 'admin', email: 'a@example.com' }) },
  });
  const res = makeRes();
  await handler({ method: 'GET', query: { resource: 'contact-info', for: 'nonsense' } }, res);
  assert.equal(res.statusCode, 400);
});

test('resource=contact-info rejects non-GET requests', async () => {
  const handler = loadWithMocks('api/lifecycle.js');
  const res = makeRes();
  await handler({ method: 'POST', query: { resource: 'contact-info' } }, res);
  assert.equal(res.statusCode, 405);
});
