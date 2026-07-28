// api/analytics.js — GET /api/analytics
const { applyCors } = require('../lib/cors');
const { dbGet } = require('../lib/db');
const { getPaymentService } = require('../lib/payments');
const { refundBooking } = require('../lib/refunds');
const { isValidId, normalizeEmail } = require('../lib/validate');
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
        const { dbPatch } = require('../lib/db');

        const bookings = await dbGet(`/bookings?id=eq.${bookingId}&limit=1`);
        const booking = bookings[0];
        if (!booking) return res.status(404).json({ error: 'Booking not found' });

        // SCRUM-88: who cancelled decides whether the family pays. The admin
        // UI passes cancelledBy; it defaults to 'seeds' rather than 'family'
        // so an unspecified admin cancellation stays free — an admin
        // cancelling without saying why should never silently charge someone.
        const { assessCancellation } = require('../lib/cancellationPolicy');
        const { cancelledBy } = req.body || {};
        const assessment = assessCancellation(booking, { cancelledBy: cancelledBy || 'seeds' });

        // Refund only what we're not charging for. A late family cancellation
        // is chargeable, so money already collected stays collected — that is
        // the entire point of the notice window.
        let refundResult = { refunded: false };
        let refundError = null;
        if (!assessment.chargeable) {
          // Always a full refund of the booking's own fee — policy is to eat
          // any Stripe processing fee rather than prorate. Resolves the
          // PaymentIntent whether the booking was charged directly (older
          // ad-hoc-checkout path) or as part of a periodic billing_batches
          // charge (SCRUM-56).
          try {
            refundResult = await refundBooking(booking, { reason: 'requested_by_customer' });
          } catch(refundErr) {
            // Log but don't block the cancellation
            console.warn('Refund failed:', refundErr.message);
            refundError = refundErr.message;
          }
        }

        const patch = { status: 'cancelled', delivery_status: assessment.deliveryStatus,
                        delivery_marked_by: admin.email, delivery_note: assessment.reason };
        if (refundResult.refunded) patch.payment_status = 'refunded';
        await dbPatch(`/bookings?id=eq.${bookingId}`, patch);
        return res.status(200).json({
          success: true,
          refundId: refundResult.refundId || null,
          refunded: refundResult.refunded,
          refundError,
          chargeable: assessment.chargeable,
          policyReason: assessment.reason,
        });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }
    if (action === 'refund-booking') {
      // Standalone refund not tied to cancellation — e.g. a partial
      // refund for a shortened lesson, issued by an admin from the
      // revenue dashboard's "Refund management" panel.
      if (!bookingId) return res.status(400).json({ error: 'bookingId required' });
      try {
        const { dbPatch } = require('../lib/db');
        const bookings = await dbGet(`/bookings?id=eq.${bookingId}&limit=1`);
        const booking = bookings[0];
        if (!booking) return res.status(404).json({ error: 'Booking not found' });

        let paymentIntentId = booking.stripe_payment_intent_id;
        if (!paymentIntentId && booking.billing_batch_id) {
          const batches = await dbGet(`/billing_batches?id=eq.${booking.billing_batch_id}&limit=1`);
          paymentIntentId = batches[0]?.stripe_payment_intent_id;
        }
        if (!paymentIntentId) return res.status(400).json({ error: 'This booking has no associated payment to refund' });

        const payments = getPaymentService();
        const amountPence = req.body.amountPence || undefined; // full refund if omitted
        const refund = await payments.createRefund({
          paymentIntentId,
          amount: amountPence,
          reason: req.body.reason || 'requested_by_customer',
        });
        // Only mark the booking itself refunded once its full fee is refunded —
        // a partial refund (e.g. a shortened lesson) leaves it 'paid'.
        if (!amountPence || amountPence >= booking.fee_pence) {
          await dbPatch(`/bookings?id=eq.${bookingId}`, { payment_status: 'refunded' });
        }
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

  // SCRUM-86: the authoritative admin roster — every real account on the
  // platform, keyed off profiles rather than the students/tutors tables.
  // Admin's Students page used to render straight from `students`, which is
  // only populated by an actual booking, so an approved-but-never-booked
  // account was invisible (SCRUM-85); the Tutors page rendered from a
  // hardcoded array of three names, so every tutor created since was
  // invisible too (SCRUM-84). Both now read this instead.
  if (req.query.resource === 'accounts') {
    if (!(await requireAdmin(req, res))) return;
    try {
      const [profiles, students, tutors] = await Promise.all([
        dbGet('/profiles?select=id,email,full_name,role,tutor_name,assigned_tutor,subject,level,created_at&order=created_at.desc'),
        dbGet('/students?select=id,parent_email,parent_name,student_name,bookings(id,status)'),
        dbGet('/tutors?select=name,email,subjects'),
      ]);
      const studentByEmail = new Map(
        students.map(s => [(s.parent_email || '').toLowerCase(), s])
      );
      const tutorByName = new Map(tutors.map(t => [t.name, t]));
      const accounts = profiles
        .filter(p => ['student', 'tutor', 'pending', 'deactivated'].includes(p.role))
        .map(p => {
          const student = studentByEmail.get((p.email || '').toLowerCase());
          const tutor = p.tutor_name ? tutorByName.get(p.tutor_name) : null;
          return {
            id: p.id,
            email: p.email,
            fullName: p.full_name,
            role: p.role,
            createdAt: p.created_at,
            // student-side
            studentId: student?.id || null,
            studentName: student?.student_name || p.full_name,
            parentName: student?.parent_name || null,
            assignedTutor: p.assigned_tutor || null,
            subject: p.subject || null,
            level: p.level || null,
            lessonCount: (student?.bookings || []).filter(b => b.status !== 'cancelled').length,
            // tutor-side
            tutorName: p.tutor_name || null,
            subjects: tutor?.subjects || null,
          };
        });
      // Tutors that exist in the canonical table but have no login yet
      // (seeded/legacy rows) still need to be visible and assignable.
      const claimed = new Set(profiles.map(p => p.tutor_name).filter(Boolean));
      const unclaimed = tutors
        .filter(t => !claimed.has(t.name))
        .map(t => ({
          id: null, email: t.email || null, fullName: t.name, role: 'tutor',
          createdAt: null, studentId: null, studentName: t.name, parentName: null,
          assignedTutor: null, subject: null, level: null, lessonCount: 0,
          tutorName: t.name, subjects: t.subjects || null, noLogin: true,
        }));
      return res.status(200).json([...accounts, ...unclaimed]);
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
        `/students?parent_email=eq.${encodeURIComponent(normalizeEmail(caller.email))}&select=id,stripe_customer_id`
      );
      if (!students.length) return res.status(200).json({ recentBookings: [] });
      const studentIds = students.map(s => s.id);
      const bookings = await dbGet(
        `/bookings?student_id=in.(${studentIds.join(',')})` +
        `&select=id,subject,tutor_name,lesson_type,start_time,fee_pence,status,payment_status,meet_link,stripe_payment_intent_id,payment_link,student_id&order=start_time.desc`
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
          paymentStatus: b.payment_status,
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
        `&select=id,subject,tutor_name,lesson_type,start_time,fee_pence,status,payment_status,meet_link,stripe_payment_intent_id,payment_link,student_id,students(student_name,parent_email,stripe_customer_id)&order=start_time.desc`
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
          paymentStatus: b.payment_status,
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
    // "Paid" must mean the student has actually paid — payment_status='paid'
    // — not just "has a fee" and not booking status. Under periodic billing
    // a booking's own status is 'confirmed' the moment it's made regardless
    // of whether it's been charged yet, so status alone can no longer tell
    // us revenue was actually collected; payment_status is the only source
    // of truth for that now (see the payment_status/status split explained
    // in the 20260724163000 migration).
    const paid = bookings.filter(b => b.fee_pence > 0 && b.payment_status === 'paid');

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

    // Lesson type breakdown — excludes cancelled, which isn't a real lesson.
    const byType = { gcse: 0, alevel: 0, group: 0, trial: 0, consultation: 0 };
    bookings.forEach(b => { if (b.status !== 'cancelled' && b.lesson_type in byType) byType[b.lesson_type]++; });

    // Per-tutor lesson counts exclude cancelled; revenue only counts what
    // was actually paid (payment_status='paid'), same as the headline
    // totalRevenue above — a lesson that's happened but not yet billed (or
    // billed but declined) previously inflated both figures here.
    const tutorMap = {};
    bookings.forEach(b => {
      if (b.status === 'cancelled') return;
      if (!tutorMap[b.tutor_name]) tutorMap[b.tutor_name] = { lessons: 0, revenue: 0, unpaid: 0 };
      tutorMap[b.tutor_name].lessons++;
      if (b.payment_status === 'paid') {
        tutorMap[b.tutor_name].revenue += b.fee_pence;
      }
    });
    // Unpaid = sum of REQUESTED payouts from payouts table (what tutor actually requested)
    // Fall back to calculating from confirmed bookings if no payout request exists
    payouts.filter(p => p.status === 'requested').forEach(p => {
      if (tutorMap[p.tutor_name]) {
        tutorMap[p.tutor_name].unpaid = p.amount_pence;
        tutorMap[p.tutor_name].payoutId = p.id;
      }
    });
    // For tutors with no payout request, show what they COULD request — only
    // for lessons the student has actually paid for (payment_status='paid');
    // a confirmed-but-unbilled lesson isn't payable to the tutor yet.
    bookings.filter(b => b.status === 'confirmed' && b.payment_status === 'paid' && b.fee_pence > 0).forEach(b => {
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
      // Not capped — the admin Bookings tab is meant to be the full log of
      // every lesson (scheduled/confirmed/completed/payment_failed/
      // cancelled), not just the most recent 25. The data is already
      // fetched in full above; slicing it here just meant older bookings
      // silently disappeared from admin's own view of the business.
      recentBookings: bookings.map(b => ({
        id: b.id,
        studentName: b.students?.student_name || '—',
        tutorName: b.tutor_name,
        subject: b.subject,
        lessonType: b.lesson_type,
        startTime: b.start_time,
        feePence: b.fee_pence,
        status: b.status,
        paymentStatus: b.payment_status,
        meetLink: b.meet_link || null,
        paymentIntentId: b.stripe_payment_intent_id || null,
        paymentLink: b.payment_link || null,
        parentEmail: b.students?.parent_email || null,
        stripeCustomerId: b.students?.stripe_customer_id || null,
        studentId: b.student_id || null,
      })),
      payouts: payouts.slice(0, 10),
      failedPayments: bookings
        .filter(b => b.payment_status === 'failed')
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
        // SCRUM-59: previously counted status === 'scheduled', a status
        // value nothing has set since bookings started going straight to
        // 'confirmed' on creation — always reported 0 ("Awaiting payment"
        // permanently showed 0 on the admin dashboard). payment_status
        // 'invoiced' (a bill/payment link sent, not yet settled) is the
        // real "awaiting payment" signal under periodic billing.
        scheduled: bookings.filter(b => b.payment_status === 'invoiced').length,
        paymentFailed: bookings.filter(b => b.status === 'payment_failed').length,
        cancelled: bookings.filter(b => b.status === 'cancelled').length,
        completed: bookings.filter(b => b.status === 'completed').length,
        // Payment-status breakdown — the actual "who's paid, who hasn't"
        // picture under periodic billing, independent of the lesson's own
        // scheduled/confirmed/completed/cancelled lifecycle above.
        unbilled: bookings.filter(b => b.payment_status === 'unbilled').length,
        invoiced: bookings.filter(b => b.payment_status === 'invoiced').length,
        paid: bookings.filter(b => b.payment_status === 'paid').length,
        failed: bookings.filter(b => b.payment_status === 'failed').length,
        totalCollected: paid.reduce((s, b) => s + b.fee_pence, 0),
        totalOutstanding: bookings
          .filter(b => b.status !== 'cancelled' && (b.payment_status === 'unbilled' || b.payment_status === 'invoiced'))
          .reduce((s, b) => s + b.fee_pence, 0),
      },
    });
  } catch (err) {
    console.error('analytics error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
