// api/lifecycle.js — CRUD for lesson_notes, homework, progress, messages, lessons, payments
// Routes by ?resource= and HTTP method
const { applyCors } = require('../lib/cors');
const { dbGet, dbPost, supabaseRequest } = require('../lib/db');
const { resolvePrice } = require('../lib/pricing');

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  const resource = req.query.resource;

  // ── LESSONS — tutor creates a booking directly ────────────────────────
  if (resource === 'lessons') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const b = req.body || {};
    if (!b.studentId || !b.tutorName || !b.startTime) {
      return res.status(400).json({ error: 'studentId, tutorName, startTime required' });
    }
    try {
      const links = {
        'Azeem Omar-Mufti': process.env.MEET_LINK_AZEEM,
        'Suleiman': process.env.MEET_LINK_SULEIMAN,
        'Abdul-Moez': process.env.MEET_LINK_ABDULMOEZ,
      };
      const feeMap = { gcse: 4000, alevel: 4500, group: 2000, trial: 0 };
      const lessonType = b.lessonType || 'gcse';
      const created = [];
      const weeks = b.recurringWeeks && b.recurringWeeks > 1 ? b.recurringWeeks : 1;
      const start = new Date(b.startTime);
      for (let i = 0; i < weeks; i++) {
        const slot = new Date(start.getTime() + i * 7 * 24 * 60 * 60 * 1000);
        const booking = await dbPost('/bookings', {
          student_id: b.studentId,
          tutor_name: b.tutorName,
          subject: b.subject || null,
          lesson_type: lessonType,
          start_time: slot.toISOString(),
          duration_mins: b.durationMins || 55,
          fee_pence: feeMap[lessonType] ?? 4000,
          status: 'confirmed',
          meet_link: links[b.tutorName] || 'https://meet.google.com/seeds-tuition',
        });
        created.push(booking);
      }
      return res.status(201).json({ success: true, created: created.length, bookings: created });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── CHARGE STUDENT for a booking ─────────────────────────────────────────
  if (resource === 'charge-student') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { bookingId, studentEmail, lessonType, studentLevel, studentName, tutorName, subject, startTime } = req.body || {};
    if (!bookingId || !studentEmail) return res.status(400).json({ error: 'bookingId and studentEmail required' });

    const stripe = getStripe();
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

    const pricing = resolvePrice(lessonType, studentLevel);
    if (pricing.amount === 0) {
      return res.status(200).json({ status: 'free', message: 'Free lesson — no charge needed' });
    }

    try {
      // Check if student has a saved Stripe customer + card
      const existing = await stripe.customers.list({ email: studentEmail, limit: 1 });
      const customer = existing.data[0] || null;

      // Check if customer has a saved payment method
      let savedPM = null;
      if (customer) {
        const pms = await stripe.paymentMethods.list({ customer: customer.id, type: 'card', limit: 1 });
        savedPM = pms.data[0] || null;
      }

      if (customer && savedPM) {
        // ── Charge saved card immediately ────────────────────────────────
        const pi = await stripe.paymentIntents.create({
          amount: pricing.amount,
          currency: 'gbp',
          customer: customer.id,
          payment_method: savedPM.id,
          confirm: true,
          off_session: true,
          description: `${pricing.label} — ${studentName} — ${tutorName}`,
          receipt_email: studentEmail,
          metadata: { bookingId, lessonType, studentName: studentName || '', tutorName: tutorName || '' },
        });
        // Update booking with payment intent
        await supabaseRequest(`/bookings?id=eq.${bookingId}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ stripe_payment_intent_id: pi.id, status: 'confirmed' }),
        });
        return res.status(200).json({
          status: 'charged',
          paymentIntentId: pi.id,
          amount: pricing.amount,
          message: `Card charged: £${(pricing.amount/100).toFixed(2)}`,
        });
      } else {
        // ── No saved card — create a Stripe Payment Link ─────────────────
        const origin = req.body.portalUrl || 'https://seeds-backend-six.vercel.app';
        const session = await stripe.checkout.sessions.create({
          mode: 'payment',
          payment_method_types: ['card'],
          customer_email: studentEmail,
          line_items: [{
            price_data: {
              currency: 'gbp',
              unit_amount: pricing.amount,
              product_data: {
                name: pricing.label,
                description: `${subject || ''} with ${tutorName} — ${new Date(startTime).toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long' })}`,
              },
            },
            quantity: 1,
          }],
          metadata: { bookingId, studentEmail },
          success_url: `${origin}?payment=success`,
          cancel_url: `${origin}?payment=cancelled`,
        });
        // Mark booking as payment_pending
        await supabaseRequest(`/bookings?id=eq.${bookingId}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ payment_link: session.url }),
        });
        return res.status(200).json({
          status: 'payment_link',
          url: session.url,
          message: 'No saved card — payment link created for student',
        });
      }
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── PAYMENT STATUS for a booking ──────────────────────────────────────────
  if (resource === 'payment-status') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const { bookingId } = req.query;
    if (!bookingId) return res.status(400).json({ error: 'bookingId required' });
    try {
      const bookings = await dbGet(`/bookings?id=eq.${bookingId}&limit=1`);
      if (!bookings.length) return res.status(404).json({ error: 'Booking not found' });
      const b = bookings[0];
      return res.status(200).json({
        bookingId, status: b.status,
        paid: !!b.stripe_payment_intent_id,
        paymentLink: b.payment_link || null,
        feePence: b.fee_pence,
      });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  const validResources = ['notes', 'homework', 'progress', 'messages'];
  if (!validResources.includes(resource)) {
    return res.status(400).json({ error: 'Invalid resource' });
  }

  const table = resource === 'notes' ? 'lesson_notes' : resource;

  try {
    // ── GET — list by student ─────────────────────────────────────────
    if (req.method === 'GET') {
      const { studentId, studentEmail } = req.query;
      let sid = studentId;
      // Allow lookup by email (student portal doesn't know its student_id)
      if (!sid && studentEmail) {
        const students = await dbGet(`/students?parent_email=eq.${encodeURIComponent(studentEmail)}&limit=1`);
        if (!students.length) return res.status(200).json([]);
        sid = students[0].id;
      }
      if (!sid) return res.status(400).json({ error: 'studentId or studentEmail required' });

      let order = 'created_at.desc';
      if (resource === 'progress') order = 'updated_at.desc';
      const data = await dbGet(`/${table}?student_id=eq.${sid}&order=${order}`);
      return res.status(200).json(data);
    }

    // ── POST — create ─────────────────────────────────────────────────
    if (req.method === 'POST') {
      const body = req.body || {};
      let record;

      if (resource === 'notes') {
        record = {
          booking_id: body.bookingId || null,
          student_id: body.studentId,
          tutor_name: body.tutorName,
          subject: body.subject || null,
          note: body.note,
        };
      } else if (resource === 'homework') {
        record = {
          student_id: body.studentId,
          tutor_name: body.tutorName,
          subject: body.subject || null,
          title: body.title,
          description: body.description || null,
          due_date: body.dueDate || null,
        };
      } else if (resource === 'progress') {
        // Upsert progress (one row per student+subject)
        const r = await supabaseRequest(
          `/progress?on_conflict=student_id,subject`,
          {
            method: 'POST',
            prefer: 'resolution=merge-duplicates,return=representation',
            body: JSON.stringify({
              student_id: body.studentId,
              subject: body.subject,
              percent: body.percent,
              target_grade: body.targetGrade || null,
              current_grade: body.currentGrade || null,
              note: body.note || null,
              updated_at: new Date().toISOString(),
            }),
          }
        );
        const data = await r.json();
        if (!r.ok) throw new Error(JSON.stringify(data));
        return res.status(201).json({ success: true, record: data[0] });
      } else if (resource === 'messages') {
        record = {
          student_id: body.studentId,
          sender_role: body.senderRole,
          sender_name: body.senderName || null,
          body: body.body,
        };
      }

      const created = await dbPost(`/${table}`, record);
      return res.status(201).json({ success: true, record: created });
    }

    // ── PATCH — update (homework completion, message read) ────────────
    if (req.method === 'PATCH') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      const updates = {};
      if (resource === 'homework') {
        if (typeof req.body.completed === 'boolean') {
          updates.completed = req.body.completed;
          updates.completed_at = req.body.completed ? new Date().toISOString() : null;
        }
      } else if (resource === 'messages') {
        if (typeof req.body.read === 'boolean') updates.read = req.body.read;
      }
      const r = await supabaseRequest(`/${table}?id=eq.${id}`, {
        method: 'PATCH', prefer: 'return=representation',
        body: JSON.stringify(updates),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(data));
      return res.status(200).json({ success: true, record: data[0] });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
