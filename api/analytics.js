// api/analytics.js — GET /api/analytics
const { applyCors } = require('../lib/cors');
const { dbGet } = require('../lib/db');
const { getPaymentService } = require('../lib/payments');
const { isValidId } = require('../lib/validate');
const { requireAdmin, requireAuth } = require('../lib/auth');
const { logAdminAction } = require('../lib/auditLog');

const TUTOR_CUT = 0.78;

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  // ── POST: booking management (cancel / reschedule / refund) — admin only ───────
  if (req.method === 'POST') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const { action, bookingId, newStartTime } = req.body || {};
    await logAdminAction({ actor: admin.email, action, targetType: 'booking', targetId: bookingId || null });
    if (action === 'cancel-booking') {
      if (!bookingId) return res.status(400).json({ error: 'bookingId required' });
      if (!isValidId(bookingId)) return res.status(400).json({ error: 'Invalid bookingId' });
      try {
        const { supabaseRequest, dbGet } = require('../lib/db');

        // Fetch booking to check if it was paid
        const bookings = await dbGet(`/bookings?id=eq.${bookingId}&limit=1`);
        const booking = bookings[0];
        let refundId = null;

        // Issue a refund if there was a payment
        if (booking?.stripe_payment_intent_id) {
          try {
            const payments = getPaymentService();
            const refund = await payments.createRefund({
              paymentIntentId: booking.stripe_payment_intent_id,
              reason: 'requested_by_customer',
            });
            refundId = refund.id;
          } catch(refundErr) {
            // Log but don't block the cancellation
            console.warn('Refund failed:', refundErr.message);
          }
        }

        const r = await supabaseRequest(`/bookings?id=eq.${bookingId}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ status: 'cancelled' }),
        });
        if (!r.ok) { const d = await r.json(); throw new Error(JSON.stringify(d)); }
        return res.status(200).json({ success: true, refundId, refunded: !!refundId });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }
    if (action === 'refund-booking') {
      // Standalone refund not tied to cancellation — e.g. a partial
      // refund for a shortened lesson, issued by an admin from the
      // revenue dashboard's "Refund management" panel.
      if (!bookingId) return res.status(400).json({ error: 'bookingId required' });
      try {
        const bookings = await dbGet(`/bookings?id=eq.${bookingId}&limit=1`);
        const booking = bookings[0];
        if (!booking) return res.status(404).json({ error: 'Booking not found' });
        if (!booking.stripe_payment_intent_id) return res.status(400).json({ error: 'This booking has no associated payment to refund' });

        const payments = getPaymentService();
        const refund = await payments.createRefund({
          paymentIntentId: booking.stripe_payment_intent_id,
          amount: req.body.amountPence || undefined, // full refund if omitted
          reason: req.body.reason || 'requested_by_customer',
        });
        return res.status(200).json({ success: true, refundId: refund.id, amount: refund.amount });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }
    if (action === 'reschedule-booking') {
      if (!bookingId || !newStartTime) return res.status(400).json({ error: 'bookingId and newStartTime required' });
      if (!isValidId(bookingId)) return res.status(400).json({ error: 'Invalid bookingId' });
      try {
        const { supabaseRequest } = require('../lib/db');
        const r = await supabaseRequest(`/bookings?id=eq.${bookingId}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ start_time: newStartTime }),
        });
        if (!r.ok) { const d = await r.json(); throw new Error(JSON.stringify(d)); }
        return res.status(200).json({ success: true });
      } catch(e) {
        if (e.message.includes('bookings_no_tutor_overlap')) {
          return res.status(409).json({ error: 'That tutor is already booked at the new time. Please choose a different slot.', conflict: true });
        }
        return res.status(500).json({ error: e.message });
      }
    }
    return res.status(400).json({ error: 'Unknown action' });
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // ?resource=students is used by the student/tutor portals for their own
  // data as well as the admin panel, so it stays open to any authenticated
  // request rather than admin-only (tightening this further needs the
  // caller's own student/tutor identity threaded through, tracked separately).
  // The comment above documented that intent, but the requireAuth call
  // implementing it was missing — every student/parent's name, email,
  // phone, and Stripe customer id was reachable with zero authentication.
  if (req.query.resource === 'students') {
    const caller = await requireAuth(req, res);
    if (!caller) return;
    try {
      const data = await dbGet(
        '/students?select=*,bookings(id,lesson_type,start_time,tutor_name,status)&order=created_at.desc'
      );
      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Pending student signups (read via service key so profiles can be locked down)
  if (req.query.resource === 'pending-profiles') {
    if (!(await requireAdmin(req, res))) return;
    try {
      const data = await dbGet(
        '/profiles?role=eq.pending&select=id,full_name,email,subject,level,created_at&order=created_at.desc'
      );
      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // A parent's own bookings/payment history + Stripe customer id —
  // self-service, scoped to the caller's own record rather than admin-only.
  // Used by the student portal (previously it called the admin-only default
  // resource below with no auth, which 401'd for every real student — this
  // replaces that broken call). Shape matches `recentBookings` below so the
  // existing frontend rendering code needs no changes beyond the URL/auth.
  if (req.query.resource === 'my-bookings') {
    const caller = await requireAuth(req, res);
    if (!caller) return;
    try {
      const students = await dbGet(
        `/students?parent_email=eq.${encodeURIComponent(caller.email)}&select=id,stripe_customer_id`
      );
      if (!students.length) return res.status(200).json({ recentBookings: [] });
      const studentIds = students.map(s => s.id);
      const bookings = await dbGet(
        `/bookings?student_id=in.(${studentIds.join(',')})` +
        `&select=id,subject,tutor_name,lesson_type,start_time,fee_pence,status,meet_link,stripe_payment_intent_id,payment_link,student_id&order=start_time.desc`
      );
      return res.status(200).json({
        recentBookings: bookings.map(b => ({
          id: b.id,
          tutorName: b.tutor_name,
          subject: b.subject,
          lessonType: b.lesson_type,
          startTime: b.start_time,
          feePence: b.fee_pence,
          status: b.status,
          meetLink: b.meet_link || null,
          paymentIntentId: b.stripe_payment_intent_id || null,
          paymentLink: b.payment_link || null,
          parentEmail: caller.email,
          stripeCustomerId: students.find(s => s.stripe_customer_id)?.stripe_customer_id || null,
          studentId: b.student_id || null,
        })),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // A tutor's own bookings — self-service, scoped to the caller's own
  // tutor_name rather than admin-only. Both the student and tutor portals'
  // "My Calendar" views were previously calling the admin-only default
  // resource below with zero auth, which always 401'd for a real caller —
  // that's why booked lessons never actually appeared on either side.
  if (req.query.resource === 'my-tutor-bookings') {
    const caller = await requireAuth(req, res);
    if (!caller) return;
    try {
      const profiles = await dbGet(`/profiles?id=eq.${caller.id}&select=tutor_name&limit=1`);
      const myTutorName = profiles[0]?.tutor_name;
      if (!myTutorName) return res.status(200).json({ recentBookings: [] });
      const bookings = await dbGet(
        `/bookings?tutor_name=eq.${encodeURIComponent(myTutorName)}` +
        `&select=id,subject,tutor_name,lesson_type,start_time,fee_pence,status,meet_link,stripe_payment_intent_id,payment_link,student_id,students(student_name,parent_email,stripe_customer_id)&order=start_time.desc`
      );
      return res.status(200).json({
        recentBookings: bookings.map(b => ({
          id: b.id,
          studentName: b.students?.student_name || '—',
          tutorName: b.tutor_name,
          subject: b.subject,
          lessonType: b.lesson_type,
          startTime: b.start_time,
          feePence: b.fee_pence,
          status: b.status,
          meetLink: b.meet_link || null,
          paymentIntentId: b.stripe_payment_intent_id || null,
          paymentLink: b.payment_link || null,
          parentEmail: b.students?.parent_email || null,
          stripeCustomerId: b.students?.stripe_customer_id || null,
          studentId: b.student_id || null,
        })),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Default (no resource param): full revenue/PII dashboard payload — admin only.
  if (!(await requireAdmin(req, res))) return;

  try {
    const [bookings, students, payouts] = await Promise.all([
      dbGet('/bookings?select=*,students(student_name,parent_email,stripe_customer_id)&order=start_time.desc'),
      dbGet('/students?select=id,student_name,parent_email,created_at'),
      dbGet('/payouts?select=*&order=requested_at.desc'),
    ]);

    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const paid = bookings.filter(b => b.fee_pence > 0);

    const totalRevenue = paid.reduce((s, b) => s + b.fee_pence, 0);
    const thisMonth    = paid.filter(b => new Date(b.start_time) >= thisMonthStart)
                             .reduce((s, b) => s + b.fee_pence, 0);
    const lastMonth    = paid.filter(b => {
      const d = new Date(b.start_time);
      return d >= lastMonthStart && d < thisMonthStart;
    }).reduce((s, b) => s + b.fee_pence, 0);

    // Monthly chart: last 12 months
    const monthly = {};
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      monthly[key] = 0;
    }
    paid.forEach(b => {
      const d = new Date(b.start_time);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      if (key in monthly) monthly[key] += b.fee_pence;
    });

    // Lesson type breakdown
    const byType = { gcse: 0, alevel: 0, group: 0, trial: 0 };
    bookings.forEach(b => { if (b.lesson_type in byType) byType[b.lesson_type]++; });

    // Per-tutor — use ALL bookings for accurate totals
    const tutorMap = {};
    bookings.forEach(b => {
      if (!tutorMap[b.tutor_name]) tutorMap[b.tutor_name] = { lessons: 0, revenue: 0, unpaid: 0 };
      tutorMap[b.tutor_name].lessons++;
      tutorMap[b.tutor_name].revenue += b.fee_pence;
    });
    // Unpaid = sum of REQUESTED payouts from payouts table (what tutor actually requested)
    // Fall back to calculating from confirmed bookings if no payout request exists
    payouts.filter(p => p.status === 'requested').forEach(p => {
      if (tutorMap[p.tutor_name]) {
        tutorMap[p.tutor_name].unpaid = p.amount_pence;
        tutorMap[p.tutor_name].payoutId = p.id;
      }
    });
    // For tutors with no payout request, show what they COULD request
    bookings.filter(b => b.status === 'confirmed' && b.fee_pence > 0).forEach(b => {
      if (tutorMap[b.tutor_name] && !tutorMap[b.tutor_name].payoutId) {
        tutorMap[b.tutor_name].unpaid += Math.round(b.fee_pence * TUTOR_CUT);
      }
    });

    res.status(200).json({
      revenue: { total: totalRevenue, thisMonth, lastMonth },
      monthly,
      byType,
      tutors: tutorMap,
      studentCount: students.length,
      bookingCount: bookings.length,
      recentBookings: bookings.slice(0, 25).map(b => ({
        id: b.id,
        studentName: b.students?.student_name || '—',
        tutorName: b.tutor_name,
        subject: b.subject,
        lessonType: b.lesson_type,
        startTime: b.start_time,
        feePence: b.fee_pence,
        status: b.status,
        meetLink: b.meet_link || null,
        paymentIntentId: b.stripe_payment_intent_id || null,
        paymentLink: b.payment_link || null,
        parentEmail: b.students?.parent_email || null,
        stripeCustomerId: b.students?.stripe_customer_id || null,
        studentId: b.student_id || null,
      })),
      payouts: payouts.slice(0, 10),
      failedPayments: bookings
        .filter(b => b.status === 'payment_failed')
        .map(b => ({
          id: b.id,
          studentName: b.students?.student_name || '—',
          parentEmail: b.students?.parent_email || null,
          tutorName: b.tutor_name,
          subject: b.subject,
          startTime: b.start_time,
          feePence: b.fee_pence,
        })),
      reconciliation: {
        confirmed: bookings.filter(b => b.status === 'confirmed').length,
        scheduled: bookings.filter(b => b.status === 'scheduled').length,
        paymentFailed: bookings.filter(b => b.status === 'payment_failed').length,
        cancelled: bookings.filter(b => b.status === 'cancelled').length,
        completed: bookings.filter(b => b.status === 'completed').length,
        totalCollected: paid.filter(b => ['confirmed', 'completed'].includes(b.status)).reduce((s, b) => s + b.fee_pence, 0),
        totalOutstanding: bookings.filter(b => b.status === 'scheduled').reduce((s, b) => s + b.fee_pence, 0),
      },
    });
  } catch (err) {
    console.error('analytics error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
