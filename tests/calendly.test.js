const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createSchedulingLink, verifyWebhookSignature, parseInviteeCreatedPayload } = require('../lib/calendly');

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) process.env[k] = prev[k];
  }
}

test('createSchedulingLink requests a single-use link and appends the tracking id', async () => {
  await withEnv({ CALENDLY_API_TOKEN: 'token_x' }, async () => {
    const origFetch = global.fetch;
    let captured;
    global.fetch = async (url, opts) => {
      captured = { url, opts };
      return { ok: true, json: async () => ({ resource: { booking_url: 'https://calendly.com/x/y' } }) };
    };
    try {
      const url = await createSchedulingLink({ eventTypeUri: 'https://api.calendly.com/event_types/abc', trackingId: 'lead-123' });
      assert.equal(url, 'https://calendly.com/x/y?utm_content=lead-123');
      assert.equal(captured.url, 'https://api.calendly.com/scheduling_links');
      const body = JSON.parse(captured.opts.body);
      assert.equal(body.owner, 'https://api.calendly.com/event_types/abc');
      assert.equal(body.max_event_count, 1);
    } finally { global.fetch = origFetch; }
  });
});

test('createSchedulingLink rejects without an event type URI', async () => {
  await assert.rejects(() => createSchedulingLink({ trackingId: 'x' }), /eventTypeUri/);
});

test('createSchedulingLink surfaces a Calendly API error message', async () => {
  await withEnv({ CALENDLY_API_TOKEN: 'token_x' }, async () => {
    const origFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ message: 'Invalid token' }) });
    try {
      await assert.rejects(
        () => createSchedulingLink({ eventTypeUri: 'https://api.calendly.com/event_types/abc' }),
        /Invalid token/
      );
    } finally { global.fetch = origFetch; }
  });
});

test('verifyWebhookSignature accepts a correctly signed payload', () => {
  const signingKey = 'test-signing-key';
  const rawBody = '{"event":"invitee.created"}';
  const timestamp = '1700000000';
  const sig = crypto.createHmac('sha256', signingKey).update(`${timestamp}.${rawBody}`).digest('hex');
  assert.doesNotThrow(() => verifyWebhookSignature(rawBody, `t=${timestamp},v1=${sig}`, signingKey));
});

test('verifyWebhookSignature rejects a tampered payload', () => {
  const signingKey = 'test-signing-key';
  const timestamp = '1700000000';
  const sig = crypto.createHmac('sha256', signingKey).update(`${timestamp}.{"event":"invitee.created"}`).digest('hex');
  assert.throws(() => verifyWebhookSignature('{"event":"tampered"}', `t=${timestamp},v1=${sig}`, signingKey), /mismatch/);
});

test('verifyWebhookSignature rejects a missing header', () => {
  assert.throws(() => verifyWebhookSignature('{}', undefined, 'key'), /Missing/);
});

test('parseInviteeCreatedPayload extracts the expected fields including tracking id', () => {
  const parsed = parseInviteeCreatedPayload({
    uri: 'https://api.calendly.com/scheduled_events/e1/invitees/i1',
    email: 'parent@example.com',
    name: 'Parent Name',
    tracking: { utm_content: 'lead-42' },
    scheduled_event: {
      uri: 'https://api.calendly.com/scheduled_events/e1',
      event_type: 'https://api.calendly.com/event_types/azeem-gcse',
      start_time: '2026-09-01T10:00:00.000000Z',
      end_time: '2026-09-01T10:55:00.000000Z',
    },
  });
  assert.equal(parsed.inviteeEmail, 'parent@example.com');
  assert.equal(parsed.eventTypeUri, 'https://api.calendly.com/event_types/azeem-gcse');
  assert.equal(parsed.trackingId, 'lead-42');
  assert.equal(parsed.startTime, '2026-09-01T10:00:00.000000Z');
});
