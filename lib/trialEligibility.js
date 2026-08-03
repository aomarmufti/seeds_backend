// lib/trialEligibility.js
// SCRUM-94. Whether a student may still book their one free trial lesson.
//
// The database enforces two halves of this (see the migration
// 20260803110000_trial_consumed_not_merely_booked.sql): one consumed trial
// per student, and one open trial at a time. Neither can express the rule
// that matters most here — "you already had your trial, so you may not book
// another" — because answering it means looking at other rows at insert time,
// which a partial index cannot do.
//
// Without this check the failure lands in the wrong place: the second trial
// would insert happily and then refuse to be marked delivered, leaving a
// tutor unable to record what happened to a lesson they had just taught.
//
// "Consumed" is deliberately narrower than "exists". A trial is used up when
// the student actually got teaching — delivered, or cut short partway. A
// no-show, a cancellation by either side, or a late cancellation all leave
// the family having received nothing.

const CONSUMED_OUTCOMES = ['delivered', 'partial'];

/**
 * Has this student already had their free trial?
 *
 * Returns { consumed: boolean, booking } — the booking is the one that used
 * it up, so a caller can say when it happened rather than only that it did.
 */
async function trialConsumed(dbGet, studentId) {
  if (!studentId) return { consumed: false, booking: null };
  const rows = await dbGet(
    `/bookings?student_id=eq.${studentId}`
    + `&lesson_type=eq.trial`
    + `&delivery_status=in.(${CONSUMED_OUTCOMES.join(',')})`
    + `&select=id,start_time,delivery_status&limit=1`,
  );
  return { consumed: rows.length > 0, booking: rows[0] || null };
}

module.exports = { trialConsumed, CONSUMED_OUTCOMES };
