// lib/cancellationPolicy.js
// SCRUM-88. One place that decides whether a cancelled lesson is chargeable.
//
// Seeds' policy: a family who cancels with at least 18 hours' notice is not
// charged. Inside 18 hours the tutor has almost certainly lost the ability to
// fill the slot, so the lesson is charged in full and the tutor is paid for
// it — the same as a no-show.
//
// This is expressed as delivery_status rather than as a bespoke flag so that
// the billing and payout sweeps need no special case: 'late_cancelled' is in
// their billable set alongside 'delivered' and 'no_show', and 'waived' is in
// neither. A cancellation therefore always leaves the booking attested —
// there is no path that cancels a lesson and leaves delivery_status null for
// the sweeps to pick over later.

const NOTICE_HOURS = 18;
const NOTICE_MS = NOTICE_HOURS * 60 * 60 * 1000;

// Who bears the cost of a cancellation depends on who caused it.
//   'family'  — apply the notice rule.
//   'tutor'   — never chargeable. The tutor withdrew; the family owes nothing
//               regardless of how little notice was given.
//   'seeds'   — never chargeable. Admin-initiated (a tutor off sick handled
//               centrally, an ops error, a goodwill cancellation).
function assessCancellation(booking, { cancelledBy = 'family', now = new Date() } = {}) {
  const start = new Date(booking.start_time);
  const noticeMs = start.getTime() - now.getTime();
  const noticeHours = noticeMs / (60 * 60 * 1000);

  if (cancelledBy !== 'family') {
    return {
      chargeable: false, deliveryStatus: 'waived', noticeHours,
      reason: `Cancelled by ${cancelledBy} — not charged to the family.`,
    };
  }
  // A free lesson has nothing to charge, so the notice rule is moot; marking
  // it 'waived' keeps it out of the billing sweep either way.
  if (!booking.fee_pence || booking.fee_pence <= 0) {
    return {
      chargeable: false, deliveryStatus: 'waived', noticeHours,
      reason: 'No fee attached to this lesson.',
    };
  }
  if (noticeMs >= NOTICE_MS) {
    return {
      chargeable: false, deliveryStatus: 'waived', noticeHours,
      reason: `Cancelled with ${Math.floor(noticeHours)}h notice (${NOTICE_HOURS}h or more) — not charged.`,
    };
  }
  // Past start_time counts as a late cancellation, not an error: a family
  // ringing up mid-slot to say nobody is coming is exactly the case the
  // policy is meant to cover, and it should not be cheaper than ringing up
  // an hour earlier.
  const described = noticeMs < 0
    ? 'after the lesson was due to start'
    : `with ${Math.max(0, Math.floor(noticeHours))}h notice`;
  return {
    chargeable: true, deliveryStatus: 'late_cancelled', noticeHours,
    reason: `Cancelled ${described} — under ${NOTICE_HOURS}h, charged in full.`,
  };
}

module.exports = { assessCancellation, NOTICE_HOURS };
