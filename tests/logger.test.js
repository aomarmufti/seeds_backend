const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const backendRoot = path.join(__dirname, '..');

function mockReminders(sendAdminAlert) {
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  const p = require.resolve(path.join(backendRoot, 'lib/reminders.js'));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: { sendAdminAlert } };
}

test('logError writes a single structured JSON line with context and message', () => {
  mockReminders(async () => {});
  const { logError } = require(path.join(backendRoot, 'lib/logger.js'));
  const original = console.error;
  let captured;
  console.error = (line) => { captured = line; };
  try {
    logError('some.context', new Error('boom'));
  } finally {
    console.error = original;
  }
  const parsed = JSON.parse(captured);
  assert.equal(parsed.context, 'some.context');
  assert.equal(parsed.message, 'boom');
  assert.equal(parsed.level, 'error');
  assert.ok(parsed.time);
});

test('alertCritical sends via sendAdminAlert with the subject and stringified details', async () => {
  let sent;
  mockReminders(async (args) => { sent = args; });
  const { alertCritical } = require(path.join(backendRoot, 'lib/logger.js'));
  await alertCritical('Test alert', { tutor: 'Azeem', amount: 5000 });
  assert.equal(sent.subject, 'Test alert');
  assert.match(sent.details, /Azeem/);
  assert.match(sent.details, /5000/);
});

test('alertCritical never throws, even if sending the alert email fails', async () => {
  mockReminders(async () => { throw new Error('SMTP down'); });
  const { alertCritical } = require(path.join(backendRoot, 'lib/logger.js'));
  await assert.doesNotReject(() => alertCritical('Test alert', 'details'));
});
