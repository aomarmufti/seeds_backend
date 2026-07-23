const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const backendRoot = path.join(__dirname, '..');

function loadTutorsWithMockDb(dbMock) {
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  const dbPath = require.resolve(path.join(backendRoot, 'lib/db.js'));
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbMock };
  return require(path.join(backendRoot, 'lib/tutors.js'));
}

test('getMeetingLink returns the tutors table value when set', async () => {
  const { getMeetingLink } = loadTutorsWithMockDb({
    dbGet: async (path) => {
      assert.equal(path, '/tutors?name=eq.Azeem%20Omar-Mufti&select=meet_link&limit=1');
      return [{ meet_link: 'https://meet.google.com/real-azeem-room' }];
    },
  });
  const link = await getMeetingLink('Azeem Omar-Mufti');
  assert.equal(link, 'https://meet.google.com/real-azeem-room');
});

test('getMeetingLink falls back to the env-var map when the tutors table has no link set', async () => {
  process.env.MEET_LINK_SULEIMAN = 'https://meet.google.com/env-suleiman-room';
  const { getMeetingLink } = loadTutorsWithMockDb({
    dbGet: async () => [{ meet_link: null }],
  });
  const link = await getMeetingLink('Suleiman');
  assert.equal(link, 'https://meet.google.com/env-suleiman-room');
  delete process.env.MEET_LINK_SULEIMAN;
});

test('getMeetingLink falls back to the default link for an unknown tutor', async () => {
  const { getMeetingLink } = loadTutorsWithMockDb({
    dbGet: async () => [],
  });
  const link = await getMeetingLink('Someone Not Registered');
  assert.equal(link, 'https://meet.google.com/seeds-tuition');
});

test('getMeetingLink falls back gracefully if the tutors table is unreachable', async () => {
  const { getMeetingLink } = loadTutorsWithMockDb({
    dbGet: async () => { throw new Error('relation "tutors" does not exist'); },
  });
  const link = await getMeetingLink('Azeem Omar-Mufti');
  assert.equal(link, 'https://meet.google.com/seeds-tuition');
});

test('getMeetingLink returns the default for a falsy tutor name without querying the DB', async () => {
  let queried = false;
  const { getMeetingLink } = loadTutorsWithMockDb({
    dbGet: async () => { queried = true; return []; },
  });
  const link = await getMeetingLink(null);
  assert.equal(link, 'https://meet.google.com/seeds-tuition');
  assert.equal(queried, false);
});

test('registerTutor upserts by name with merge-duplicates', async () => {
  let captured;
  const { registerTutor } = loadTutorsWithMockDb({
    supabaseRequest: async (path, opts) => { captured = { path, opts }; return { ok: true, json: async () => ({}) }; },
  });
  await registerTutor({ name: 'New Tutor', email: 'nt@example.com', subjects: 'Physics' });
  assert.equal(captured.path, '/tutors?on_conflict=name');
  assert.equal(captured.opts.prefer, 'resolution=merge-duplicates,return=minimal');
  assert.deepEqual(JSON.parse(captured.opts.body), { name: 'New Tutor', email: 'nt@example.com', subjects: 'Physics' });
});

test('registerTutor is a no-op without a name and never throws on failure', async () => {
  const { registerTutor } = loadTutorsWithMockDb({
    supabaseRequest: async () => { throw new Error('db unreachable'); },
  });
  await assert.doesNotReject(registerTutor({ name: null }));
  await assert.doesNotReject(registerTutor({ name: 'Someone', email: 'x@example.com' }));
});
