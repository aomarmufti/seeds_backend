// api/lifecycle.js — CRUD for lesson_notes, homework, progress, messages, lessons, payments
// Routes by ?resource= and HTTP method
const { applyCors } = require('../lib/cors');
const { dbGet, dbPost, supabaseRequest } = require('../lib/db');
const { resolvePrice } = require('../lib/pricing');
const { requireCronSecret } = require('../lib/cronAuth');
const { escapeHtml } = require('../lib/escapeHtml');

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  const resource = req.query.resource;

  // ── AUTO WEEKLY PAYOUT (Vercel cron every Sunday midnight) ──────────────
  if (resource === 'auto-payout') {
    if (!requireCronSecret(req, res)) return;
    const stripe = getStripe();
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
    try {
      const accounts = await dbGet('/tutor_accounts?onboarding_complete=eq.true');
      const results = [];
      for (const acct of accounts) {
        const bookings = await dbGet(
          `/bookings?tutor_name=eq.${encodeURIComponent(acct.tutor_name)}&status=eq.confirmed&fee_pence=gt.0`
        );
        if (!bookings.length) { results.push({ tutor: acct.tutor_name, status: 'nothing_due' }); continue; }
        const amount = Math.round(bookings.reduce((s,b) => s + b.fee_pence, 0) * 0.78);
        if (amount < 5000) { results.push({ tutor: acct.tutor_name, status: 'below_minimum', amount }); continue; }
        try {
          const payoutWeek = new Date().toISOString().slice(0,10);
          const transfer = await stripe.transfers.create({
            amount, currency: 'gbp',
            destination: acct.stripe_account_id,
            description: `Seeds weekly payout — ${acct.tutor_name} — ${payoutWeek}`,
          }, { idempotencyKey: `auto-payout:${acct.tutor_name}:${payoutWeek}` });
          await supabaseRequest(
            `/bookings?tutor_name=eq.${encodeURIComponent(acct.tutor_name)}&status=eq.confirmed&fee_pence=gt.0`,
            { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'completed' }) }
          );
          await dbPost('/payouts', {
            tutor_name: acct.tutor_name, amount_pence: amount,
            status: 'paid', paid_at: new Date().toISOString(),
            stripe_transfer_id: transfer.id, transfer_status: 'paid',
          });
          results.push({ tutor: acct.tutor_name, status: 'paid', amount, transferId: transfer.id });
          // Notify tutor
          try {
            const { sendPayoutNotification } = require('../lib/reminders');
            if (acct.tutor_email) {
              await sendPayoutNotification({
                tutorEmail: acct.tutor_email, tutorName: acct.tutor_name,
                amountPence: amount, transferId: transfer.id, isAutomatic: true,
              });
            }
          } catch(e) { console.warn('Payout email:', e.message); }
        } catch(e) {
          results.push({ tutor: acct.tutor_name, status: 'failed', error: e.message });
        }
      }
      return res.status(200).json({ success: true, processed: results.length, results });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

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
        const slotStart = new Date(start.getTime() + i * 7 * 24 * 60 * 60 * 1000);
        const slotEnd   = new Date(slotStart.getTime() + (b.durationMins || 55) * 60 * 1000);

        // ── Conflict detection ──────────────────────────────────────────
        const conflicts = await dbGet(
          `/bookings?tutor_name=eq.${encodeURIComponent(b.tutorName)}&status=neq.cancelled&start_time=gte.${slotStart.toISOString()}&start_time=lt.${slotEnd.toISOString()}&limit=1`
        );
        if (conflicts.length) {
          if (weeks === 1) {
            return res.status(409).json({
              error: `${b.tutorName} already has a lesson at that time. Please choose a different slot.`,
              conflict: true,
              existingLesson: { startTime: conflicts[0].start_time },
            });
          }
          // Skip conflicting week in recurring series
          created.push({ skipped: true, startTime: slotStart.toISOString(), reason: 'conflict' });
          continue;
        }
        const booking = await dbPost('/bookings', {
          student_id: b.studentId,
          tutor_name: b.tutorName,
          subject: b.subject || null,
          lesson_type: lessonType,
          start_time: slotStart.toISOString(),
          duration_mins: b.durationMins || 55,
          fee_pence: feeMap[lessonType] ?? 4000,
          status: 'confirmed',
          meet_link: links[b.tutorName] || 'https://meet.google.com/seeds-tuition',
        });
        created.push(booking);
      }
      const booked = created.filter(c => !c.skipped);
      const skipped = created.filter(c => c.skipped);
      return res.status(201).json({
        success: true,
        created: booked.length,
        skipped: skipped.length,
        bookings: booked,
        ...(skipped.length ? { note: `${skipped.length} slot(s) skipped due to conflicts` } : {}),
      });
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
        }, { idempotencyKey: `booking-charge:${bookingId}` });
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
        }, { idempotencyKey: `booking-payment-link:${bookingId}` });
        // Mark booking as payment_pending
        await supabaseRequest(`/bookings?id=eq.${bookingId}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ payment_link: session.url }),
        });

        // Email the payment link to the student
        try {
          const nodemailer = require('nodemailer');
          const transporter = nodemailer.createTransport({
            host: 'smtp.resend.com', port: 587, secure: false,
            auth: { user: 'resend', pass: process.env.RESEND_API_KEY },
          });
          const lessonDate = new Date(startTime).toLocaleDateString('en-GB', {weekday:'long',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'});
          await transporter.sendMail({
            from: `"Seeds Tuition" <${process.env.EMAIL_FROM}>`,
            to: studentEmail,
            subject: `Payment required — ${subject || 'lesson'} with ${tutorName}`,
            html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f5f5f0;margin:0;padding:24px">
              <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden">
                <div style="background:#0D1B2A;padding:24px 28px">
                  <h1 style="font-family:Georgia,serif;color:#fff;margin:0;font-size:22px">Seeds Tuition</h1>
                </div>
                <div style="padding:24px 28px">
                  <h2 style="font-family:Georgia,serif;color:#0D1B2A;margin-bottom:8px">Payment required for your lesson</h2>
                  <p style="color:#4A5568;font-size:15px">Hi ${studentName},</p>
                  <p style="color:#4A5568;font-size:15px">${tutorName} has scheduled a ${subject || ''} lesson for <strong>${lessonDate}</strong>. Please pay to confirm your place.</p>
                  <div style="background:#FAF8F4;border-radius:10px;padding:14px 16px;margin:18px 0;font-size:14px">
                    <div style="display:flex;justify-content:space-between;margin-bottom:6px"><span style="color:#718096">Subject</span><span style="font-weight:600">${subject||'—'}</span></div>
                    <div style="display:flex;justify-content:space-between;margin-bottom:6px"><span style="color:#718096">Tutor</span><span style="font-weight:600">${tutorName}</span></div>
                    <div style="display:flex;justify-content:space-between"><span style="color:#718096">Amount</span><span style="font-weight:700;color:#0D1B2A">£${(pricing.amount/100).toFixed(2)}</span></div>
                  </div>
                  <a href="${session.url}" style="display:block;background:#0D1B2A;color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:10px;font-weight:700;font-size:15px;margin-bottom:16px">Pay £${(pricing.amount/100).toFixed(2)} now →</a>
                  <p style="font-size:12px;color:#A7A7A7">Secured by Stripe. Your card details are never stored on Seeds' servers.</p>
                </div>
              </div>
            </body></html>`,
          });
        } catch(emailErr) { console.warn('Payment link email failed:', emailErr.message); }

        return res.status(200).json({
          status: 'payment_link',
          url: session.url,
          message: 'No saved card — payment link emailed to student',
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

  // ── AVAILABILITY (tutor saves their available slots) ─────────────────────
  if (resource === 'availability') {
    if (req.method === 'GET') {
      const { tutorName } = req.query;
      if (!tutorName) return res.status(400).json({ error: 'tutorName required' });
      try {
        const profiles = await dbGet(`/profiles?tutor_name=eq.${encodeURIComponent(tutorName)}&limit=1`);
        return res.status(200).json({ slots: profiles[0]?.availability || [] });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }
    if (req.method === 'POST') {
      const { tutorName, slots } = req.body || {};
      if (!tutorName) return res.status(400).json({ error: 'tutorName required' });
      try {
        const r = await supabaseRequest(`/profiles?tutor_name=eq.${encodeURIComponent(tutorName)}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ availability: slots || [] }),
        });
        if (!r.ok) { const d = await r.json(); throw new Error(JSON.stringify(d)); }
        return res.status(200).json({ success: true });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }
  }

  // ── PROGRESS HISTORY (trend over time) ───────────────────────────────────
  if (resource === 'progress-history') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
    const { studentId, studentEmail, subject } = req.query;
    let sid = studentId;
    if (!sid && studentEmail) {
      const students = await dbGet(`/students?parent_email=eq.${encodeURIComponent(studentEmail)}&limit=1`);
      sid = students[0]?.id;
    }
    if (!sid) return res.status(400).json({ error: 'studentId or studentEmail required' });
    try {
      let path = `/progress_history?student_id=eq.${sid}&order=created_at.asc`;
      if (subject) path += `&subject=eq.${encodeURIComponent(subject)}`;
      return res.status(200).json(await dbGet(path));
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── ADMIN NOTES on leads ──────────────────────────────────────────────────
  if (resource === 'lead-notes') {
    const { leadId, adminNotes } = req.body || {};
    if (req.method === 'POST') {
      if (!leadId) return res.status(400).json({ error: 'leadId required' });
      try {
        const r = await supabaseRequest(`/leads?id=eq.${leadId}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ admin_notes: adminNotes || '' }),
        });
        if (!r.ok) throw new Error('Failed');
        return res.status(200).json({ success: true });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }
  }

  // ── INVOICE (per-lesson receipt as HTML page) ─────────────────────────
  if (resource === 'invoice') {
    const { bookingId } = req.query;
    if (!bookingId) return res.status(400).json({ error: 'bookingId required' });
    try {
      const bookings = await dbGet(`/bookings?id=eq.${bookingId}&select=*,students(student_name,parent_name,parent_email)&limit=1`);
      if (!bookings.length) return res.status(404).json({ error: 'Booking not found' });
      const b = bookings[0];
      const date = new Date(b.start_time).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
      const typeLabel = {gcse:'GCSE 1:1 Lesson',alevel:'A-Level 1:1 Lesson',group:'Group Session',trial:'Free Trial Lesson'}[b.lesson_type]||b.lesson_type;
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Seeds Receipt</title>
      <style>body{font-family:Arial,sans-serif;max-width:600px;margin:40px auto;color:#0D1B2A;padding:20px}
      .header{background:#0D1B2A;color:#fff;padding:24px;border-radius:12px;margin-bottom:24px}
      .header h1{font-family:Georgia,serif;margin:0;font-size:24px}
      .header p{margin:4px 0 0;opacity:.5;font-size:13px}
      table{width:100%;border-collapse:collapse;margin:20px 0}
      td{padding:10px 0;border-bottom:1px solid #E8E8E8;font-size:14px}
      td:last-child{text-align:right;font-weight:600}
      .total td{font-size:16px;font-weight:700;border-bottom:none}
      .footer{margin-top:30px;font-size:12px;color:#A7A7A7;text-align:center}
      @media print{body{margin:0}}</style></head>
      <body>
        <div class="header"><h1>Seeds Tuition</h1><p>Receipt #${escapeHtml(bookingId.slice(0,8).toUpperCase())}</p></div>
        <table>
          <tr><td>Student</td><td>${escapeHtml(b.students?.student_name)||'—'}</td></tr>
          <tr><td>Parent / billed to</td><td>${escapeHtml(b.students?.parent_name||b.students?.student_name)||'—'}</td></tr>
          <tr><td>Date</td><td>${date}</td></tr>
          <tr><td>Tutor</td><td>${escapeHtml(b.tutor_name)}</td></tr>
          <tr><td>Subject</td><td>${escapeHtml(b.subject)||'—'}</td></tr>
          <tr><td>Type</td><td>${escapeHtml(typeLabel)}</td></tr>
          <tr><td>Duration</td><td>${b.duration_mins||55} minutes</td></tr>
          <tr class="total"><td>Amount paid</td><td>&pound;${((b.fee_pence||0)/100).toFixed(2)}</td></tr>
        </table>
        ${b.stripe_payment_intent_id?`<p style="font-size:12px;color:#718096">Payment reference: ${escapeHtml(b.stripe_payment_intent_id)}</p>`:''}
        <div class="footer">Seeds Tuition &bull; seedstuition.co.uk &bull; Thank you for choosing Seeds</div>
        <script>window.print();</script>
      </body></html>`;
      res.setHeader('Content-Type','text/html; charset=utf-8');
      return res.status(200).send(html);
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── TAX STATEMENT (annual earnings for tutor self-assessment) ─────────
  if (resource === 'tax-statement') {
    const { tutorName, taxYear } = req.query; // taxYear e.g. "2025-26"
    if (!tutorName) return res.status(400).json({ error: 'tutorName required' });
    try {
      const year = taxYear || new Date().getFullYear() + '-' + (new Date().getFullYear()+1-2000);
      const [startY] = (taxYear||'').split('-');
      const startDate = startY ? `${startY}-04-06` : `${new Date().getFullYear()-1}-04-06`;
      const endDate = startY ? `${parseInt(startY)+1}-04-05` : `${new Date().getFullYear()}-04-05`;
      const bookings = await dbGet(
        `/bookings?tutor_name=eq.${encodeURIComponent(tutorName)}&status=eq.completed&fee_pence=gt.0` +
        `&start_time=gte.${startDate}&start_time=lte.${endDate}&order=start_time.asc`
      );
      const totalFee = bookings.reduce((s,b) => s + b.fee_pence, 0);
      const tutorEarnings = Math.round(totalFee * 0.78);
      const payouts = await dbGet(
        `/payouts?tutor_name=eq.${encodeURIComponent(tutorName)}&status=eq.paid&order=paid_at.asc`
      );
      const totalPaidOut = payouts.reduce((s,p) => s + p.amount_pence, 0);
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Seeds Tax Statement ${year}</title>
      <style>body{font-family:Arial,sans-serif;max-width:700px;margin:40px auto;color:#0D1B2A;padding:20px}
      h1{font-family:Georgia,serif;color:#0D1B2A}
      table{width:100%;border-collapse:collapse;margin:16px 0;font-size:13px}
      th{background:#0D1B2A;color:#fff;padding:8px;text-align:left}
      td{padding:7px 8px;border-bottom:1px solid #E8E8E8}
      .summary{background:#FAF8F4;border-radius:10px;padding:16px;margin:20px 0}
      @media print{body{margin:0}}</style></head>
      <body>
        <h1>Seeds Tuition — Earnings Statement</h1>
        <p><strong>Tutor:</strong> ${escapeHtml(tutorName)}<br>
        <strong>Tax year:</strong> 6 April ${startY||new Date().getFullYear()-1} to 5 April ${startY?parseInt(startY)+1:new Date().getFullYear()}</p>
        <div class="summary">
          <div style="display:flex;justify-content:space-between;margin-bottom:8px"><span>Total lessons delivered</span><strong>${bookings.length}</strong></div>
          <div style="display:flex;justify-content:space-between;margin-bottom:8px"><span>Gross lesson fees collected</span><strong>&pound;${(totalFee/100).toFixed(2)}</strong></div>
          <div style="display:flex;justify-content:space-between;margin-bottom:8px"><span>Your share (78%)</span><strong>&pound;${(tutorEarnings/100).toFixed(2)}</strong></div>
          <div style="display:flex;justify-content:space-between"><span>Total paid out to you</span><strong style="color:#2D7A4F">&pound;${(totalPaidOut/100).toFixed(2)}</strong></div>
        </div>
        <h3>All lessons</h3>
        <table><thead><tr><th>Date</th><th>Student</th><th>Subject</th><th>Fee</th><th>Your cut</th></tr></thead>
        <tbody>${bookings.map(b=>`<tr>
          <td>${new Date(b.start_time).toLocaleDateString('en-GB')}</td>
          <td>${b.student_id}</td>
          <td>${b.subject||'—'}</td>
          <td>&pound;${(b.fee_pence/100).toFixed(2)}</td>
          <td>&pound;${(b.fee_pence*0.78/100).toFixed(2)}</td>
        </tr>`).join('')}</tbody></table>
        <p style="font-size:11px;color:#A7A7A7;margin-top:20px">This statement is for self-assessment reference only. Seeds Tuition is not responsible for tax filing. Please consult an accountant.</p>
        <script>window.print();</script>
      </body></html>`;
      res.setHeader('Content-Type','text/html; charset=utf-8');
      return res.status(200).send(html);
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── BULK CANCEL (admin cancels all lessons on a date/by tutor) ────────
  if (resource === 'bulk-cancel') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    const { tutorName, date, reason } = req.body || {};
    if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
    try {
      // Find all confirmed bookings on that date
      const dayStart = new Date(date + 'T00:00:00Z').toISOString();
      const dayEnd = new Date(date + 'T23:59:59Z').toISOString();
      let path = `/bookings?status=eq.confirmed&start_time=gte.${dayStart}&start_time=lte.${dayEnd}`;
      if (tutorName) path += `&tutor_name=eq.${encodeURIComponent(tutorName)}`;
      const bookings = await dbGet(path + '&select=id,stripe_payment_intent_id');

      let cancelled = 0, refunded = 0;
      const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

      for (const b of bookings) {
        // Refund if paid
        if (b.stripe_payment_intent_id && stripe) {
          try {
            await stripe.refunds.create({ payment_intent: b.stripe_payment_intent_id, reason: 'requested_by_customer' });
            refunded++;
          } catch(e) { console.warn('Refund failed:', b.id, e.message); }
        }
        await supabaseRequest(`/bookings?id=eq.${b.id}`,
          { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'cancelled' }) }
        );
        cancelled++;
      }
      return res.status(200).json({ success: true, cancelled, refunded });
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

        // Log to progress_history for trend tracking
        try {
          await dbPost('/progress_history', {
            student_id: body.studentId, subject: body.subject,
            percent: body.percent, grade: body.currentGrade || null,
            note: body.note || null,
          });
        } catch(e) { console.warn('Progress history log failed:', e.message); }

        // Email student when progress updated
        if (body.notifyStudent !== false) {
          try {
            const students = await dbGet(`/students?id=eq.${body.studentId}&limit=1`);
            const student = students[0];
            if (student?.parent_email) {
              const nodemailer = require('nodemailer');
              const transporter = nodemailer.createTransport({
                host: 'smtp.resend.com', port: 465, secure: true,
                auth: { user: 'resend', pass: process.env.RESEND_API_KEY },
              });
              await transporter.sendMail({
                from: `"Seeds Tuition" <${process.env.EMAIL_FROM}>`,
                to: student.parent_email,
                subject: `Progress update: ${body.subject} — ${student.student_name}`,
                html: `<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px">
                  <h2 style="color:#0D1B2A;font-family:Georgia,serif">📈 Progress update from Seeds</h2>
                  <p>Your tutor has updated ${student.student_name}'s progress in <strong>${body.subject}</strong>:</p>
                  <div style="background:#FAF8F4;border-radius:10px;padding:16px;margin:16px 0">
                    <div style="display:flex;justify-content:space-between;margin-bottom:8px">
                      <span style="color:#718096">Coverage</span>
                      <strong>${body.percent}%</strong>
                    </div>
                    ${body.currentGrade ? `<div style="display:flex;justify-content:space-between;margin-bottom:8px"><span style="color:#718096">Current grade</span><strong>${body.currentGrade}</strong></div>` : ''}
                    ${body.targetGrade ? `<div style="display:flex;justify-content:space-between"><span style="color:#718096">Target grade</span><strong>${body.targetGrade}</strong></div>` : ''}
                  </div>
                  ${body.note ? `<p style="color:#4A5568;font-size:14px;font-style:italic">"${body.note}"</p>` : ''}
                  <p style="font-size:12px;color:#A7A7A7">Log in to Seeds to see the full progress breakdown.</p>
                </div>`,
              });
            }
          } catch(emailErr) { console.warn('Progress email failed:', emailErr.message); }
        }

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

      // Notify student when homework is assigned
      if (resource === 'homework' && body.title) {
        try {
          const students = await dbGet(`/students?id=eq.${body.studentId}&limit=1`);
          const student = students[0];
          if (student?.parent_email) {
            const nodemailer = require('nodemailer');
            const transporter = nodemailer.createTransport({
              host: 'smtp.resend.com', port: 465, secure: true,
              auth: { user: 'resend', pass: process.env.RESEND_API_KEY },
            });
            const dueStr = body.dueDate ? new Date(body.dueDate).toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long'}) : 'No due date';
            await transporter.sendMail({
              from: `"Seeds Tuition" <${process.env.EMAIL_FROM}>`,
              to: student.parent_email,
              subject: `New homework set: ${body.title}`,
              html: `<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px">
                <h2 style="color:#0D1B2A;font-family:Georgia,serif">📝 New homework from Seeds</h2>
                <p>${body.tutorName} has set homework for ${student.student_name}:</p>
                <div style="background:#FAF8F4;border-radius:10px;padding:16px;margin:16px 0">
                  <div style="font-weight:700;color:#0D1B2A;font-size:15px;margin-bottom:8px">${body.title}</div>
                  ${body.description ? `<div style="color:#4A5568;font-size:14px;margin-bottom:8px">${body.description}</div>` : ''}
                  <div style="color:#C8A15A;font-size:13px;font-weight:600">📅 Due: ${dueStr}</div>
                </div>
                <p style="font-size:12px;color:#A7A7A7">Log in to Seeds to mark it complete when done.</p>
              </div>`,
            });
          }
        } catch(emailErr) { console.warn('Homework email failed:', emailErr.message); }
      }
      if (resource === 'messages' && body.body) {
        try {
          const { sendMessageNotification } = require('../lib/reminders');
          const senderRole = body.senderRole;
          const studentId = body.studentId;
          // Find student email
          const students = await dbGet(`/students?id=eq.${studentId}&limit=1`);
          const studentEmail = students[0]?.parent_email;
          const studentName = students[0]?.student_name || 'Student';
          const portalUrl = body.portalUrl || null;

          if (senderRole === 'student' || senderRole === 'parent') {
            // Student messaged — notify the tutor
            // Get tutor via bookings
            const bk = await dbGet(`/bookings?student_id=eq.${studentId}&status=neq.cancelled&order=start_time.desc&limit=1`);
            const tutorName = bk[0]?.tutor_name;
            if (tutorName) {
              const profiles = await dbGet(`/profiles?tutor_name=eq.${encodeURIComponent(tutorName)}&limit=1`);
              const tutorEmail = profiles[0]?.email;
              if (tutorEmail) {
                await sendMessageNotification({
                  recipientEmail: tutorEmail, recipientName: tutorName,
                  senderName: body.senderName || studentName, senderRole,
                  preview: body.body, portalUrl,
                });
              }
            }
          } else {
            // Tutor/admin messaged — notify the student
            if (studentEmail) {
              await sendMessageNotification({
                recipientEmail: studentEmail, recipientName: studentName,
                senderName: body.senderName || 'Your tutor', senderRole,
                preview: body.body, portalUrl,
              });
            }
          }
        } catch(emailErr) { console.warn('Message notification failed:', emailErr.message); }
      }

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
