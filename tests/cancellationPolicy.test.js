// SCRUM-88 — the 18-hour notice rule.
const test = require('node:test');
const assert = require('node:assert');
const { assessCancellation, NOTICE_HOURS } = require('../lib/cancellationPolicy');

const NOW = new Date('2026-03-10T12:00:00Z');
const at = (hoursFromNow) => ({
  fee_pence: 4000,
  start_time: new Date(NOW.getTime() + hoursFromNow * 3600 * 1000).toISOString(),
});

test('the notice window is 18 hours', () => {
  assert.equal(NOTICE_HOURS, 18);
});

test('a family cancelling with more than 18h notice is not charged', () => {
  const r = assessCancellation(at(48), { cancelledBy: 'family', now: NOW });
  assert.equal(r.chargeable, false);
  assert.equal(r.deliveryStatus, 'waived');
});

test('exactly 18h notice is not charged — the boundary favours the family', () => {
  const r = assessCancellation(at(18), { cancelledBy: 'family', now: NOW });
  assert.equal(r.chargeable, false, '18h notice is "at least 18 hours", so it is free');
  assert.equal(r.deliveryStatus, 'waived');
});

test('a minute inside the window is charged in full', () => {
  const r = assessCancellation(
    { fee_pence: 4000, start_time: new Date(NOW.getTime() + (18 * 3600 - 60) * 1000).toISOString() },
    { cancelledBy: 'family', now: NOW }
  );
  assert.equal(r.chargeable, true);
  assert.equal(r.deliveryStatus, 'late_cancelled');
});

test('cancelling after the lesson was due to start is a late cancellation, not an error', () => {
  // A family ringing up mid-slot must not come out cheaper than one that
  // rang an hour beforehand.
  const r = assessCancellation(at(-0.5), { cancelledBy: 'family', now: NOW });
  assert.equal(r.chargeable, true);
  assert.equal(r.deliveryStatus, 'late_cancelled');
  assert.match(r.reason, /after the lesson was due to start/);
});

test('a tutor cancelling their own lesson never charges the family, however late', () => {
  const r = assessCancellation(at(0.25), { cancelledBy: 'tutor', now: NOW });
  assert.equal(r.chargeable, false);
  assert.equal(r.deliveryStatus, 'waived');
});

test('an admin/Seeds cancellation never charges the family, however late', () => {
  const r = assessCancellation(at(0.25), { cancelledBy: 'seeds', now: NOW });
  assert.equal(r.chargeable, false);
  assert.equal(r.deliveryStatus, 'waived');
});

test('a free lesson is never chargeable even cancelled with no notice', () => {
  const r = assessCancellation(
    { fee_pence: 0, start_time: new Date(NOW.getTime() + 60000).toISOString() },
    { cancelledBy: 'family', now: NOW }
  );
  assert.equal(r.chargeable, false);
  assert.equal(r.deliveryStatus, 'waived');
});

test('every outcome is one the billing sweep understands', () => {
  // The sweep's billable set is ('delivered','no_show','late_cancelled') and
  // 'waived' is explicitly excluded. A cancellation must never produce null,
  // which would leave the booking unattested and silently unbillable.
  const cases = [
    assessCancellation(at(48), { cancelledBy: 'family', now: NOW }),
    assessCancellation(at(1), { cancelledBy: 'family', now: NOW }),
    assessCancellation(at(1), { cancelledBy: 'tutor', now: NOW }),
    assessCancellation(at(1), { cancelledBy: 'seeds', now: NOW }),
  ];
  for (const c of cases) {
    assert.ok(['waived', 'late_cancelled'].includes(c.deliveryStatus), `unexpected: ${c.deliveryStatus}`);
    assert.equal(c.chargeable, c.deliveryStatus === 'late_cancelled', 'chargeable must agree with the status');
  }
});

test('defaults to the family notice rule when no canceller is named', () => {
  assert.equal(assessCancellation(at(1), { now: NOW }).chargeable, true);
  assert.equal(assessCancellation(at(48), { now: NOW }).chargeable, false);
});
