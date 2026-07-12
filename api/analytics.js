// api/analytics.js — GET /api/analytics
const { applyCors } = require('../lib/cors');
const { dbGet } = require('../lib/db');

const TUTOR_CUT = 0.78;

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  // ── POST: booking management (cancel / reschedule) ────────────────────
  if (req.method === 'POST') {
    const { action, bookingId, newStartTime } = req.body || {};
    if (action === 'cancel-booking') {
      if (!bookingId) return res.status(400).json({ error: 'bookingId required' });
      try {
        const { supabaseRequest, dbGet } = require('../lib/db');

        // Fetch booking to check if it was paid
        const bookings = await dbGet(`/bookings?id=eq.${bookingId}&limit=1`);
        const booking = bookings[0];
        let refundId = null;

        // Issue Stripe refund if there was a payment
        if (booking?.stripe_payment_intent_id && process.env.STRIPE_SECRET_KEY) {
          try {
            const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
            const refund = await stripe.refunds.create({
              payment_intent: booking.stripe_payment_intent_id,
              reason: 'requested_by_customer',
            });
            refundId = refund.id;
          } catch(stripeErr) {
            // Log but don't block the cancellation
            console.warn('Stripe refund failed:', stripeErr.message);
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
    if (action === 'reschedule-booking') {
      if (!bookingId || !newStartTime) return res.status(400).json({ error: 'bookingId and newStartTime required' });
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

  // ?resource=students returns the full students list with bookings
  if (req.query.resource === 'students') {
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
    try {
      const data = await dbGet(
        '/profiles?role=eq.pending&select=id,full_name,email,subject,level,created_at&order=created_at.desc'
      );
      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  try {
    const [bookings, students, payouts] = await Promise.all([
      dbGet('/bookings?select=*,students(student_name,parent_email)&order=start_time.desc'),
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
        parentEmail: b.students?.parent_email || null,
        studentId: b.student_id || null,
      })),
      payouts: payouts.slice(0, 10),
    });
  } catch (err) {
    console.error('analytics error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
