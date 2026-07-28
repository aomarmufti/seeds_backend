const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWithMocks, makeRes } = require('./helpers/loadWithMocks');

// api/auth.js previously called the shared supabaseRequest() (which auto-
// prepends /rest/v1 to whatever path it's given) with paths that ALREADY
// included /rest/v1 or /auth/v1 — producing malformed URLs like
// /rest/v1/rest/v1/profiles or /rest/v1/auth/v1/admin/users. Auth Admin API
// calls now go through the dedicated supabaseAdminRequest() (no auto-prefix,
// since that API lives at the project root, not under /rest/v1), and table
// calls pass plain paths to supabaseRequest() so its auto-prefix is the only
// one applied. These tests assert the exact paths passed to each, so a
// regression back to double-prefixed paths fails loudly.

test('create-student calls the admin API and profiles table with correct (non-doubled) paths', async () => {
  const adminCalls = [];
  const dbCalls = [];
  const handler = loadWithMocks('api/auth.js', {
    db: {
      supabaseAdminRequest: async (path) => {
        adminCalls.push(path);
        return path.endsWith('/recovery')
          ? { ok: true, json: async () => ({}) }
          : { ok: true, json: async () => ({ id: 'user-1' }) };
      },
      supabaseRequest: async (path) => { dbCalls.push(path); return { ok: true, json: async () => ({}) }; },
    },
  });
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'create-student', fullName: 'Jo Test', email: 'jo@example.com' } }, res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(adminCalls, ['/auth/v1/admin/users', '/auth/v1/admin/users/user-1/recovery']);
  assert.deepEqual(dbCalls.filter(p => p !== '/admin_audit_log'), ['/profiles']);
});

test('approve-student patches the profiles table with a plain path', async () => {
  const dbCalls = [];
  const handler = loadWithMocks('api/auth.js', {
    db: {
      supabaseRequest: async (path) => { dbCalls.push(path); return { ok: true, json: async () => ({}) }; },
      supabaseAdminRequest: async () => ({ ok: true, json: async () => ({}) }),
    },
  });
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'approve-student', userId: 'user-1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(dbCalls.filter(p => p !== '/admin_audit_log'), ['/profiles?id=eq.user-1']);
});

test('approve-student with role:tutor registers a tutor instead of assigning a student', async () => {
  const dbCalls = [];
  let registered = null;
  const handler = loadWithMocks('api/auth.js', {
    db: {
      dbGet: async () => [{ email: 'pending@example.com', full_name: 'Pending Person' }],
      supabaseRequest: async (path, opts) => { dbCalls.push({ path, body: opts && JSON.parse(opts.body) }); return { ok: true, json: async () => ({}) }; },
      supabaseAdminRequest: async () => ({ ok: true, json: async () => ({}) }),
    },
    tutors: { registerTutor: async (args) => { registered = args; } },
  });
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'approve-student', userId: 'user-1', role: 'tutor', tutorName: 'Pending Person', subjects: 'Physics' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(registered, { name: 'Pending Person', email: 'pending@example.com', subjects: 'Physics' });
  const profilesPatch = dbCalls.find(c => c.path === '/profiles?id=eq.user-1');
  assert.deepEqual(profilesPatch.body, { role: 'tutor', tutor_name: 'Pending Person' });
});

test('invite-tutor registers the tutor in the canonical tutors table', async () => {
  let registered = null;
  const handler = loadWithMocks('api/auth.js', {
    db: {
      supabaseAdminRequest: async (path) => path.endsWith('/recovery')
        ? { ok: true, json: async () => ({}) }
        : { ok: true, json: async () => ({ id: 'user-1' }) },
      supabaseRequest: async () => ({ ok: true, json: async () => ({}) }),
    },
    tutors: { registerTutor: async (args) => { registered = args; } },
  });
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'invite-tutor', fullName: 'New Tutor', email: 'new@example.com', subjects: 'Maths' } }, res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(registered, { name: 'New Tutor', email: 'new@example.com', subjects: 'Maths' });
});

test('edit-tutor renames via the tutors table (not profiles directly) when the tutor name changes', async () => {
  const dbCalls = [];
  const handler = loadWithMocks('api/auth.js', {
    db: {
      dbGet: async () => [{ tutor_name: 'Old Name' }],
      supabaseRequest: async (path, opts) => { dbCalls.push({ path, body: opts?.body }); return { ok: true, json: async () => ({}) }; },
    },
  });
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'edit-tutor', userId: 'user-1', tutorName: 'New Name' } }, res);
  assert.equal(res.statusCode, 200);
  const relevant = dbCalls.filter(c => c.path !== '/admin_audit_log');
  assert.equal(relevant.length, 1);
  assert.equal(relevant[0].path, '/tutors?name=eq.Old%20Name');
  assert.deepEqual(JSON.parse(relevant[0].body), { name: 'New Name' });
});

test('edit-tutor sets tutor_name directly on profiles when the tutor has none yet', async () => {
  const dbCalls = [];
  const handler = loadWithMocks('api/auth.js', {
    db: {
      dbGet: async () => [{ tutor_name: null }],
      supabaseRequest: async (path, opts) => { dbCalls.push({ path, body: opts?.body }); return { ok: true, json: async () => ({}) }; },
    },
  });
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'edit-tutor', userId: 'user-1', tutorName: 'Brand New Tutor' } }, res);
  assert.equal(res.statusCode, 200);
  const relevant = dbCalls.filter(c => c.path !== '/admin_audit_log');
  assert.equal(relevant.length, 1);
  assert.equal(relevant[0].path, '/profiles?id=eq.user-1');
  assert.deepEqual(JSON.parse(relevant[0].body), { tutor_name: 'Brand New Tutor' });
});

// SCRUM-74: admin UI for each tutor's Cal.com scheduling links, keyed by
// tutor name (not userId) since these live on the tutors table alone.
test('get-tutor-links returns the tutor\'s three Cal.com links', async () => {
  const handler = loadWithMocks('api/auth.js', {
    db: {
      dbGet: async (p) => {
        assert.match(p, /^\/tutors\?name=eq\.Suleiman/);
        return [{ cal_lesson_link: 'https://cal.eu/suleiman/lesson', cal_consultation_link: null, cal_trial_link: '' }];
      },
    },
  });
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'get-tutor-links', tutorName: 'Suleiman' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    calLessonLink: 'https://cal.eu/suleiman/lesson',
    calConsultationLink: '',
    calTrialLink: '',
  });
});

test('get-tutor-links 404s for an unknown tutor', async () => {
  const handler = loadWithMocks('api/auth.js', { db: { dbGet: async () => [] } });
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'get-tutor-links', tutorName: 'Nobody' } }, res);
  assert.equal(res.statusCode, 404);
});

test('get-tutor-links requires tutorName', async () => {
  const handler = loadWithMocks('api/auth.js');
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'get-tutor-links' } }, res);
  assert.equal(res.statusCode, 400);
});

test('edit-tutor-links patches only the provided links on the tutors table', async () => {
  const dbCalls = [];
  const handler = loadWithMocks('api/auth.js', {
    db: { supabaseRequest: async (path, opts) => { dbCalls.push({ path, body: opts?.body }); return { ok: true, json: async () => ({}) }; } },
  });
  const res = makeRes();
  await handler({
    method: 'POST',
    body: { action: 'edit-tutor-links', tutorName: 'Abdul-Moez', calLessonLink: 'https://cal.eu/abdul-moez/lesson', calTrialLink: '' },
  }, res);
  assert.equal(res.statusCode, 200);
  const relevant = dbCalls.filter(c => c.path !== '/admin_audit_log');
  assert.equal(relevant.length, 1);
  assert.equal(relevant[0].path, '/tutors?name=eq.Abdul-Moez');
  // An explicitly cleared field (empty string from the form) writes null,
  // not left untouched — distinguished from a field never sent at all
  // (calConsultationLink here, correctly absent from the patch body).
  assert.deepEqual(JSON.parse(relevant[0].body), {
    cal_lesson_link: 'https://cal.eu/abdul-moez/lesson',
    cal_trial_link: null,
  });
});

test('edit-tutor-links requires tutorName', async () => {
  const handler = loadWithMocks('api/auth.js');
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'edit-tutor-links', calLessonLink: 'x' } }, res);
  assert.equal(res.statusCode, 400);
});

test('edit-tutor-links requires at least one link field', async () => {
  const handler = loadWithMocks('api/auth.js');
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'edit-tutor-links', tutorName: 'Suleiman' } }, res);
  assert.equal(res.statusCode, 400);
});

test('deactivate-tutor bans via the admin API and patches profiles with plain paths', async () => {
  const adminCalls = [];
  const dbCalls = [];
  const handler = loadWithMocks('api/auth.js', {
    db: {
      supabaseAdminRequest: async (path) => { adminCalls.push(path); return { ok: true, json: async () => ({}) }; },
      supabaseRequest: async (path) => { dbCalls.push(path); return { ok: true, json: async () => ({}) }; },
    },
  });
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'deactivate-tutor', userId: 'user-1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(adminCalls, ['/auth/v1/admin/users/user-1']);
  assert.deepEqual(dbCalls.filter(p => p !== '/admin_audit_log'), ['/profiles?id=eq.user-1']);
});

test('unknown action returns 400', async () => {
  const handler = loadWithMocks('api/auth.js');
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'not-a-real-action' } }, res);
  assert.equal(res.statusCode, 400);
});

test('non-admin caller is rejected before any action runs', async () => {
  const handler = loadWithMocks('api/auth.js', {
    auth: { requireAdmin: async (req, res) => { res.status(401).json({ error: 'Unauthorized' }); return null; } },
  });
  const res = makeRes();
  await handler({ method: 'POST', body: { action: 'create-student', fullName: 'X', email: 'x@example.com' } }, res);
  assert.equal(res.statusCode, 401);
});
