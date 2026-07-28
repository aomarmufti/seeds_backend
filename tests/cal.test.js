const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { verifyWebhookSignature, parseBookingPayload } = require('../lib/cal');

test('verifyWebhookSignature accepts a correctly signed payload', () => {
  const signingSecret = 'test-signing-secret';
  const rawBody = '{"triggerEvent":"BOOKING_CREATED"}';
  const sig = crypto.createHmac('sha256', signingSecret).update(rawBody).digest('hex');
  assert.doesNotThrow(() => verifyWebhookSignature(rawBody, sig, signingSecret));
});

test('verifyWebhookSignature rejects a tampered payload', () => {
  const signingSecret = 'test-signing-secret';
  const sig = crypto.createHmac('sha256', signingSecret).update('{"triggerEvent":"BOOKING_CREATED"}').digest('hex');
  assert.throws(() => verifyWebhookSignature('{"triggerEvent":"tampered"}', sig, signingSecret), /mismatch/);
});

test('verifyWebhookSignature rejects a missing header', () => {
  assert.throws(() => verifyWebhookSignature('{}', undefined, 'secret'), /Missing/);
});

test('verifyWebhookSignature rejects a missing signing secret', () => {
  assert.throws(() => verifyWebhookSignature('{}', 'abc', undefined), /not configured/);
});

test('parseBookingPayload extracts the expected fields including tracking id', () => {
  const parsed = parseBookingPayload({
    uid: 'booking-uid-123',
    type: 'consultation',
    startTime: '2026-09-01T10:00:00.000Z',
    endTime: '2026-09-01T10:15:00.000Z',
    attendees: [{ email: 'parent@example.com', name: 'Parent Name' }],
    metadata: { trackingId: 'lead-42' },
  });
  assert.equal(parsed.bookingUid, 'booking-uid-123');
  assert.equal(parsed.attendeeEmail, 'parent@example.com');
  assert.equal(parsed.attendeeName, 'Parent Name');
  assert.equal(parsed.trackingId, 'lead-42');
  assert.equal(parsed.startTime, '2026-09-01T10:00:00.000Z');
  assert.equal(parsed.endTime, '2026-09-01T10:15:00.000Z');
});

test('parseBookingPayload handles a payload with no attendees or metadata', () => {
  const parsed = parseBookingPayload({ uid: 'x', startTime: 's', endTime: 'e' });
  assert.equal(parsed.attendeeEmail, undefined);
  assert.equal(parsed.trackingId, undefined);
});
