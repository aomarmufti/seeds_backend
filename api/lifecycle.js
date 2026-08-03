// api/lifecycle.js — CRUD for lesson_notes, homework, progress, lessons, payments
// Routes by ?resource= and HTTP method
const { applyCors } = require('../lib/cors');
const { dbGet, dbPost, supabaseRequest } = require('../lib/db');
const { resolvePrice } = require('../lib/pricing');
const { requireCronSecret } = require('../lib/cronAuth');
const { escapeHtml } = require('../lib/escapeHtml');
const { isValidId, normalizeEmail } = require('../lib/validate');
const { requireAdmin, requireAuth } = require('../lib/auth');
const { logAdminAction } = require('../lib/auditLog');
const { getMeetingLink } = require('../lib/tutors');
const { refundBooking } = require('../lib/refunds');

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

// SCRUM-13: none of notes/homework/progress/lessons/availability originally
// checked who was calling — any caller who knew or guessed a studentId could
// read or write another family's private tutoring data. This resolves
// whether `caller` is allowed to act on `studentId`: the student's own
// parent, the tutor actually assigned to them (via a real booking, not a
// client-supplied tutorName), or an admin.
async function verifyStudentAccess(caller, studentId) {
  if (caller.role === 'admin') return true;
  const students = await dbGet(`/students?id=eq.${studentId}&select=parent_email&limit=1`);
  const parentEmail = students[0]?.parent_email;
  if (parentEmail && parentEmail.toLowerCase() === caller.email.toLowerCase()) return true;
  const callerProfile = await dbGet(`/profiles?id=eq.${caller.id}&select=tutor_name&limit=1`);
  const myTutorName = callerProfile[0]?.tutor_name;
  if (!myTutorName) return false;
  const bookings = await dbGet(
    `/bookings?student_id=eq.${studentId}&tutor_name=eq.${encodeURIComponent(myTutorName)}&limit=1`
  );
  return bookings.length > 0;
}

// Same idea for endpoints keyed by tutorName instead of studentId (a
// tutor's own availability, or a tutor creating a lesson for themselves).
async function verifyTutorIdentity(caller, tutorName) {
  if (caller.role === 'admin') return true;
  const callerProfile = await dbGet(`/profiles?id=eq.${caller.id}&select=tutor_name&limit=1`);
  return callerProfile[0]?.tutor_name === tutorName;
}

// A logged-in student/parent booking their own first lesson from the portal
// has no `students` row yet (that's normally created by the public booking
// wizard or a tutor/admin) — self-heal it from the caller's OWN verified
// email rather than blocking booking with "contact your tutor", matching
// what the public wizard already does for a brand-new family.
async function findOrCreateOwnStudentRecord(caller, studentName) {
  const email = normalizeEmail(caller.email);
  const existing = await dbGet(`/students?parent_email=eq.${encodeURIComponent(email)}&limit=1`);
  if (existing.length) return existing[0];
  return dbPost('/students', {
    parent_name: studentName || caller.email,
    parent_email: email,
    student_name: studentName || caller.email,
  });
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  const resource = req.query.resource;

  // ── CONTACT INFO (SCRUM-55: email + opt-in WhatsApp, no message storage) ──
  // A parent/tutor can look up the OTHER party's contact card, but only for
  // a relationship that actually exists (a real booking between them) —
  // this is the ownership check SCRUM-13 flagged as missing elsewhere, done
  // properly from the start here rather than trusting a client-supplied id.
  if (resource === 'contact-info') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const caller = await requireAuth(req, res);
    if (!caller) return;
    const { for: forParty, tutorName, studentId } = req.query;
    try {
      if (forParty === 'tutor') {
        if (!tutorName) return res.status(400).json({ error: 'tutorName required' });
        // Caller must be the parent on at least one real booking with this tutor.
        const students = await dbGet(`/students?parent_email=eq.${encodeURIComponent(normalizeEmail(caller.email))}&select=id`);
        const studentIds = students.map(s => s.id);
        if (!studentIds.length) return res.status(403).json({ error: 'Forbidden' });
        const bookings = await dbGet(
          `/bookings?tutor_name=eq.${encodeURIComponent(tutorName)}&student_id=in.(${studentIds.join(',')})&limit=1`
        );
        if (!bookings.length) return res.status(403).json({ error: 'Forbidden' });
        const profiles = await dbGet(`/profiles?tutor_name=eq.${encodeURIComponent(tutorName)}&role=eq.tutor&select=email,whatsapp_number,whatsapp_opted_in&limit=1`);
        const tutor = profiles[0];
        if (!tutor) return res.status(404).json({ error: 'Tutor contact info not available' });
        return res.status(200).json({
          email: tutor.email || null,
          whatsappNumber: tutor.whatsapp_opted_in ? tutor.whatsapp_number : null,
        });
      }
      if (forParty === 'parent') {
        if (!studentId) return res.status(400).json({ error: 'studentId required' });
        if (!isValidId(studentId)) return res.status(400).json({ error: 'Invalid studentId' });
        // Caller must be the tutor on at least one real booking with this
        // student. getAuthedUser doesn't resolve tutor_name, so look it up
        // from the caller's own profile rather than trusting a client value.
        const callerProfile = await dbGet(`/profiles?id=eq.${caller.id}&select=tutor_name&limit=1`);
        const myTutorName = callerProfile[0]?.tutor_name;
        if (!myTutorName) return res.status(403).json({ error: 'Forbidden' });
        const ownBookings = await dbGet(
          `/bookings?student_id=eq.${studentId}&tutor_name=eq.${encodeURIComponent(myTutorName)}&limit=1`
        );
        if (!ownBookings.length) return res.status(403).json({ error: 'Forbidden' });
        const students = await dbGet(`/students?id=eq.${studentId}&select=parent_email&limit=1`);
        const parentEmail = students[0]?.parent_email;
        if (!parentEmail) return res.status(404).json({ error: 'Parent contact info not available' });
        const profiles = await dbGet(`/profiles?email=eq.${encodeURIComponent(parentEmail)}&select=whatsapp_number,whatsapp_opted_in&limit=1`);
        const parent = profiles[0];
        return res.status(200).json({
          email: parentEmail,
          whatsappNumber: parent?.whatsapp_opted_in ? parent.whatsapp_number : null,
        });
      }
      return res.status(400).json({ error: 'for must be "tutor" or "parent"' });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── MATERIALS (SCRUM-25 tutor Resources panel + SCRUM-24 Group Sessions
  // recordings, descoped to a pasted link — Google Drive/OneDrive/Zoom
  // recording etc. — rather than real file storage) ───────────────────────
  if (resource === 'materials') {
    const caller = await requireAuth(req, res);
    if (!caller) return;

    if (req.method === 'GET') {
      const { tutorName, studentId, type } = req.query;
      try {
        if (tutorName) {
          // Tutor's own view of everything they've added.
          if (!(await verifyTutorIdentity(caller, tutorName))) return res.status(403).json({ error: 'Forbidden' });
          let path = `/resources?tutor_name=eq.${encodeURIComponent(tutorName)}&order=created_at.desc`;
          if (type) path += `&type=eq.${encodeURIComponent(type)}`;
          return res.status(200).json(await dbGet(path));
        }
        if (studentId) {
          // Student's view: their own tutor's materials + anything shared
          // with all of that tutor's students (student_id is null).
          if (!isValidId(studentId)) return res.status(400).json({ error: 'Invalid studentId' });
          if (!(await verifyStudentAccess(caller, studentId))) return res.status(403).json({ error: 'Forbidden' });
          let path = `/resources?or=(student_id.eq.${studentId},student_id.is.null)&order=created_at.desc`;
          if (type) path += `&type=eq.${encodeURIComponent(type)}`;
          return res.status(200).json(await dbGet(path));
        }
        return res.status(400).json({ error: 'tutorName or studentId required' });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    if (req.method === 'POST') {
      const { tutorName, studentId, type, subject, title, url } = req.body || {};
      if (!tutorName || !title || !url) return res.status(400).json({ error: 'tutorName, title, and url required' });
      if (!(await verifyTutorIdentity(caller, tutorName))) return res.status(403).json({ error: 'Forbidden' });
      if (studentId) {
        if (!isValidId(studentId)) return res.status(400).json({ error: 'Invalid studentId' });
        const ownBookings = await dbGet(`/bookings?student_id=eq.${studentId}&tutor_name=eq.${encodeURIComponent(tutorName)}&limit=1`);
        if (!ownBookings.length) return res.status(403).json({ error: 'Forbidden' });
      }
      try {
        const created = await dbPost('/resources', {
          tutor_name: tutorName,
          student_id: studentId || null,
          type: type === 'recording' ? 'recording' : 'resource',
          subject: subject || null,
          title, url,
        });
        return res.status(201).json({ success: true, record: created });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    if (req.method === 'DELETE') {
      const { id, tutorName } = req.query;
      if (!id || !isValidId(id)) return res.status(400).json({ error: 'Invalid id' });
      if (!tutorName || !(await verifyTutorIdentity(caller, tutorName))) return res.status(403).json({ error: 'Forbidden' });
      try {
        const r = await supabaseRequest(`/resources?id=eq.${id}&tutor_name=eq.${encodeURIComponent(tutorName)}`, {
          method: 'DELETE', prefer: 'return=minimal',
        });
        if (!r.ok) { const d = await r.json(); throw new Error(JSON.stringify(d)); }
        return res.status(200).json({ success: true });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── AUTO PAYOUT (Vercel cron, daily) — SCRUM-76: each tutor's cadence is
  // now admin-set (tutor_accounts.payout_cycle), same weekly-Sunday /
  // monthly-1st split api/billing.js's billing-cron already uses for
  // student billing, rather than paying every onboarded tutor weekly.
  if (resource === 'auto-payout') {
    if (!requireCronSecret(req, res)) return;
    const stripe = getStripe();
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
    try {
      const today = new Date();
      const cyclesDueToday = [];
      if (today.getUTCDay() === 0) cyclesDueToday.push('weekly'); // every Sunday
      if (today.getUTCDate() === 1) cyclesDueToday.push('monthly'); // 1st of month
      if (!cyclesDueToday.length) {
        return res.status(200).json({ success: true, processed: 0, note: 'Not a payout day for either cycle' });
      }
      const allAccounts = await dbGet('/tutor_accounts?onboarding_complete=eq.true');
      const accounts = allAccounts.filter(a => cyclesDueToday.includes(a.payout_cycle || 'weekly'));
      const results = [];
      const nowIso = new Date().toISOString();
      for (const acct of accounts) {
        // Only pay a tutor out for a lesson once (a) the STUDENT has
        // actually paid for it (payment_status='paid') — under periodic
        // billing, a booking is confirmed the moment it's made regardless
        // of whether it's been charged yet — AND (b) somebody attested to
        // what actually happened. delivery_status replaces the old
        // end_time<=now() proxy, which only ever meant "the slot has
        // passed", not "the lesson ran". A family paying their billing
        // cycle in advance of a lesson that hasn't run yet must never
        // translate into paying the tutor out for it early; "you get paid
        // for what you complete" applies to both sides of this marketplace,
        // not just the family's side.
        const bookings = await dbGet(
          `/bookings?tutor_name=eq.${encodeURIComponent(acct.tutor_name)}&delivery_status=in.(delivered,no_show,late_cancelled,partial)&payment_status=eq.paid&fee_pence=gt.0&paid_out_at=is.null`
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
          // Mark exactly the bookings this transfer paid for, by id. The old
          // code re-ran the selection query here, so any booking that became
          // eligible between the SELECT and this PATCH — a lesson marked
          // delivered seconds earlier, a payment landing mid-run — was
          // flagged paid out while contributing nothing to the transfer
          // amount, and would never be paid.
          await supabaseRequest(
            `/bookings?id=in.(${bookings.map(b => b.id).join(',')})`,
            { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ paid_out_at: new Date().toISOString() }) }
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
  // Called by both the student portal (booking a lesson for themselves) and
  // the tutor portal (adding a lesson for one of their students), so the
  // caller must be either the enrolment's tutor or that student's own parent.
  // Accepts enrolmentId instead of tutorName/subject/studentLevel (SCRUM-XX49).
  if (resource === 'lessons') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const b = req.body || {};
    if (!b.enrolmentId || !b.startTime) {
      return res.status(400).json({ error: 'enrolmentId and startTime required' });
    }
    if (!isValidId(b.enrolmentId)) {
      return res.status(400).json({ error: 'Invalid enrolmentId' });
    }
    const caller = await requireAuth(req, res);
    if (!caller) return;

    try {
      // Fetch the enrolment to validate it exists and is active
      const enrolments = await dbGet(`/enrolments?id=eq.${b.enrolmentId}&limit=1`);
      if (!enrolments.length) {
        return res.status(404).json({ error: 'Enrolment not found' });
      }
      const enrolment = enrolments[0];
      if (enrolment.status !== 'active') {
        return res.status(409).json({ error: 'Enrolment is not active' });
      }

      const studentId = enrolment.student_id;
      const tutorId = enrolment.tutor_id;
      const subject = enrolment.subject;
      const ratePence = enrolment.rate_pence;

      // Verify caller access
      const isTutor = tutorId && caller.role === 'tutor'
        ? (await dbGet(`/profiles?id=eq.${caller.id}&tutor_id=eq.${tutorId}&limit=1`)).length > 0
        : false;
      const isParent = await verifyStudentAccess(caller, studentId);

      if (!isTutor && !isParent) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      // Get tutor name for conflict detection and meeting link
      let tutorName = null;
      if (tutorId) {
        const tutors = await dbGet(`/tutors?id=eq.${tutorId}&select=name&limit=1`);
        tutorName = tutors[0]?.name;
      }

      const meetingLink = tutorName ? await getMeetingLink(tutorName) : null;
      const lessonType = b.lessonType || 'gcse';
      const price = resolvePrice(lessonType, enrolment.level);
      const created = [];
      const weeks = b.recurringWeeks && b.recurringWeeks > 1 ? b.recurringWeeks : 1;
      const start = new Date(b.startTime);

      for (let i = 0; i < weeks; i++) {
        const slotStart = new Date(start.getTime() + i * 7 * 24 * 60 * 60 * 1000);
        const slotEnd   = new Date(slotStart.getTime() + (b.durationMins || price.duration) * 60 * 1000);

        // ── Conflict detection (if tutor assigned) ──────────────────────
        if (tutorName) {
          const conflicts = await dbGet(
            `/bookings?tutor_name=eq.${encodeURIComponent(tutorName)}&status=neq.cancelled&start_time=gte.${slotStart.toISOString()}&start_time=lt.${slotEnd.toISOString()}&limit=1`
          );
          if (conflicts.length) {
            if (weeks === 1) {
              return res.status(409).json({
                error: `${tutorName} already has a lesson at that time. Please choose a different slot.`,
                conflict: true,
                existingLesson: { startTime: conflicts[0].start_time },
              });
            }
            // Skip conflicting week in recurring series
            created.push({ skipped: true, startTime: slotStart.toISOString(), reason: 'conflict' });
            continue;
          }
        }

        const fee = ratePence || price.amount;
        const booking = await dbPost('/bookings', {
          student_id: studentId,
          enrolment_id: b.enrolmentId,
          tutor_name: tutorName || null,
          subject: subject || null,
          lesson_type: lessonType,
          start_time: slotStart.toISOString(),
          duration_mins: b.durationMins || price.duration,
          fee_pence: fee,
          status: (!isTutor && fee === 0) ? 'requested' : 'confirmed',
          payment_status: fee === 0 ? 'free' : 'unbilled',
          meet_link: meetingLink,
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
      if (e.message.includes('bookings_one_trial_per_student')) {
        return res.status(409).json({
          error: 'This student has already booked their free trial lesson.',
          conflict: true,
        });
      }
      return res.status(500).json({ error: e.message });
    }
  }

  // ── CHARGE STUDENT for a booking ─────────────────────────────────────────
  // Previously trusted whatever studentEmail/lessonType/amount-determining
  // fields the caller sent, with no auth at all — meaning any caller who
  // knew (or guessed) a bookingId could direct a real charge at an
  // arbitrary email's saved card, for an amount they chose via lessonType/
  // studentLevel, tagged with a bookingId of their choosing. Now the
  // booking is the source of truth: only bookingId is trusted from the
  // request, everything else (who's charged, how much, for what) is looked
  // up from the real record.
  if (resource === 'charge-student') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { bookingId } = req.body || {};
    if (!bookingId) return res.status(400).json({ error: 'bookingId required' });
    if (!isValidId(bookingId)) return res.status(400).json({ error: 'Invalid bookingId' });

    const caller = await requireAuth(req, res);
    if (!caller) return;

    const bookingRows = await dbGet(`/bookings?id=eq.${bookingId}&select=*,students(student_name,parent_email)&limit=1`);
    const booking = bookingRows[0];
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    // Either the tutor charging their student (no saved card on file) or
    // the student themselves proactively paying a pending charge.
    const isTutor = await verifyTutorIdentity(caller, booking.tutor_name);
    if (!isTutor && !(await verifyStudentAccess(caller, booking.student_id))) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const tutorName = booking.tutor_name;
    const subject = booking.subject;
    const startTime = booking.start_time;
    const studentName = booking.students?.student_name;
    const studentEmail = booking.students?.parent_email;
    if (!studentEmail) return res.status(400).json({ error: 'No parent email on file for this booking' });

    const stripe = getStripe();
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

    const pricing = resolvePrice(booking.lesson_type, booking.lesson_type);
    if (pricing.amount === 0) {
      return res.status(200).json({ status: 'free', message: 'Free lesson — no charge needed' });
    }
    const lessonType = booking.lesson_type;

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
        let pi;
        try {
          pi = await stripe.paymentIntents.create({
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
        } catch (chargeErr) {
          // A declined card (or any other Stripe charge failure) previously
          // fell through to the generic 500 below and left the booking's
          // status untouched — silently stuck as "scheduled" with no
          // record of the failed attempt, and no clear signal to the
          // caller beyond a raw Stripe error message.
          await supabaseRequest(`/bookings?id=eq.${bookingId}`, {
            method: 'PATCH', prefer: 'return=minimal',
            body: JSON.stringify({ status: 'payment_failed', payment_status: 'failed' }),
          });
          if (chargeErr.type === 'StripeCardError') {
            return res.status(402).json({
              status: 'failed', error: 'card_declined',
              message: chargeErr.message, code: chargeErr.code,
            });
          }
          throw chargeErr;
        }
        // Update booking with payment intent
        await supabaseRequest(`/bookings?id=eq.${bookingId}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ stripe_payment_intent_id: pi.id, status: 'confirmed', payment_status: 'paid' }),
        });
        return res.status(200).json({
          status: 'charged',
          paymentIntentId: pi.id,
          amount: pricing.amount,
          message: `Card charged: £${(pricing.amount/100).toFixed(2)}`,
        });
      } else {
        // ── No saved card — create a Stripe Payment Link ─────────────────
        const origin = req.body.portalUrl || process.env.FRONTEND_URL || 'https://seedsinstitute.co.uk';
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
          body: JSON.stringify({ payment_link: session.url, payment_status: 'invoiced' }),
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
    if (!isValidId(bookingId)) return res.status(400).json({ error: 'Invalid bookingId' });
    try {
      const bookings = await dbGet(`/bookings?id=eq.${bookingId}&limit=1`);
      if (!bookings.length) return res.status(404).json({ error: 'Booking not found' });
      const b = bookings[0];
      return res.status(200).json({
        bookingId, status: b.status,
        paymentStatus: b.payment_status,
        paid: b.payment_status === 'paid' || b.payment_status === 'free',
        paymentLink: b.payment_link || null,
        feePence: b.fee_pence,
      });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── PROGRESS HISTORY (trend over time) ───────────────────────────────────
  if (resource === 'progress-history') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
    const { studentId, subject } = req.query;
    const caller = await requireAuth(req, res);
    if (!caller) return;
    let sid = studentId;
    if (!sid) {
      // Resolve from the caller's own email rather than trusting a
      // client-supplied studentEmail, which would let anyone look up
      // another parent's progress history just by knowing their email.
      const students = await dbGet(`/students?parent_email=eq.${encodeURIComponent(normalizeEmail(caller.email))}&limit=1`);
      sid = students[0]?.id;
    }
    if (!sid) return res.status(400).json({ error: 'studentId required' });
    if (!isValidId(sid)) return res.status(400).json({ error: 'Invalid studentId' });
    if (!(await verifyStudentAccess(caller, sid))) return res.status(403).json({ error: 'Forbidden' });
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
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      if (!leadId) return res.status(400).json({ error: 'leadId required' });
      if (!isValidId(leadId)) return res.status(400).json({ error: 'Invalid leadId' });
      await logAdminAction({ actor: admin.email, action: 'lead-notes', targetType: 'lead', targetId: leadId });
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
    if (!isValidId(bookingId)) return res.status(400).json({ error: 'Invalid bookingId' });
    try {
      const bookings = await dbGet(`/bookings?id=eq.${bookingId}&select=*,students(student_name,parent_name,parent_email)&limit=1`);
      if (!bookings.length) return res.status(404).json({ error: 'Booking not found' });
      const b = bookings[0];
      const date = new Date(b.start_time).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
      const typeLabel = {gcse:'GCSE 1:1 Lesson',alevel:'A-Level 1:1 Lesson',group:'Group Session',trial:'Free Trial Lesson',consultation:'Initial Consultation'}[b.lesson_type]||b.lesson_type;
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
        <div class="footer">Seeds Tuition &bull; seedsinstitute.co.uk &bull; Thank you for choosing Seeds</div>
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
      // Earnings = lessons actually paid out to the tutor. This read
      // status='completed' back when that flag was what the payout path
      // set; paid_out_at is now the marker, and status='completed' means
      // the lesson was taught — which is not the same set (an unpaid
      // delivered lesson is taught but not yet earned). The window still
      // keys off start_time, so the statement continues to report by when
      // the work was done rather than when the transfer cleared.
      const bookings = await dbGet(
        `/bookings?tutor_name=eq.${encodeURIComponent(tutorName)}&paid_out_at=not.is.null&fee_pence=gt.0` +
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
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const { tutorName, date, reason } = req.body || {};
    if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
    await logAdminAction({ actor: admin.email, action: 'bulk-cancel', targetType: 'tutor', targetId: tutorName || null, details: { date, reason } });
    try {
      // Find all confirmed bookings on that date
      const dayStart = new Date(date + 'T00:00:00Z').toISOString();
      const dayEnd = new Date(date + 'T23:59:59Z').toISOString();
      let path = `/bookings?status=eq.confirmed&start_time=gte.${dayStart}&start_time=lte.${dayEnd}`;
      if (tutorName) path += `&tutor_name=eq.${encodeURIComponent(tutorName)}`;
      const bookings = await dbGet(path + '&select=id,stripe_payment_intent_id,billing_batch_id,payment_status,fee_pence');

      let cancelled = 0, refunded = 0, refundFailed = 0;

      for (const b of bookings) {
        // SCRUM-88: a bulk-cancel is always Seeds' own doing — a tutor off
        // sick, a snow day, an ops correction — so it is never chargeable to
        // the families involved, whatever the notice. 'waived' settles each
        // booking so none is left null for the billing sweep to find.
        const patch = { status: 'cancelled', delivery_status: 'waived',
                        delivery_marked_by: admin.email,
                        delivery_note: `Bulk cancellation${reason ? ': ' + reason : ''} — not charged.` };
        try {
          const result = await refundBooking(b, { reason: 'requested_by_customer' });
          if (result.refunded) { refunded++; patch.payment_status = 'refunded'; }
        } catch(e) {
          console.warn('Refund failed:', b.id, e.message);
          refundFailed++;
        }
        await supabaseRequest(`/bookings?id=eq.${b.id}`,
          { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(patch) }
        );
        cancelled++;
      }
      if (refundFailed) {
        const { alertCritical } = require('../lib/logger');
        await alertCritical('Bulk-cancel: some refunds failed', `${refundFailed} of ${bookings.length} refunds failed for tutor=${tutorName || 'all'} date=${date} — check Stripe dashboard.`);
      }
      return res.status(200).json({ success: true, cancelled, refunded, refundFailed });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── SELF-CANCEL / SELF-RESCHEDULE (tutor manages their own lesson) ───────
  // SCRUM-57: the only cancellation path used to be admin-only
  // (api/analytics.js action=cancel-booking) — a tutor had no way to
  // cancel or reschedule their own lesson without going through an admin.
  // A frontend modal for this (tpOpenSelfManage) already existed but was
  // unreachable: it called the admin-only endpoint directly, which would
  // 403 for a non-admin tutor even if wired up.
  // SCRUM-87: tutor accepts a free session a student requested for
  // themselves, flipping it from 'requested' to a normal confirmed booking
  // and sending the family the usual confirmation + meeting link.
  if (resource === 'confirm-booking') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    const caller = await requireAuth(req, res);
    if (!caller) return;
    const { bookingId } = req.body || {};
    if (!bookingId) return res.status(400).json({ error: 'bookingId required' });
    if (!isValidId(bookingId)) return res.status(400).json({ error: 'Invalid bookingId' });
    try {
      const bookings = await dbGet(`/bookings?id=eq.${bookingId}&limit=1`);
      const booking = bookings[0];
      if (!booking) return res.status(404).json({ error: 'Booking not found' });
      if (!(await verifyTutorIdentity(caller, booking.tutor_name))) return res.status(403).json({ error: 'Forbidden' });
      if (booking.status === 'cancelled') return res.status(409).json({ error: 'This request was cancelled.' });
      if (booking.status !== 'requested') return res.status(409).json({ error: 'This lesson is already confirmed.' });

      const r = await supabaseRequest(`/bookings?id=eq.${bookingId}`, {
        method: 'PATCH', prefer: 'return=representation',
        body: JSON.stringify({ status: 'confirmed' }),
      });
      const updated = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(updated));

      try {
        const students = await dbGet(`/students?id=eq.${booking.student_id}&limit=1`);
        const student = students[0];
        if (student?.parent_email) {
          const { sendBookingConfirmation } = require('../lib/reminders');
          await sendBookingConfirmation({
            parentName: student.parent_name || student.student_name,
            parentEmail: student.parent_email,
            studentName: student.student_name,
            tutorName: booking.tutor_name,
            subject: booking.subject || '',
            lessonType: booking.lesson_type,
            startTime: booking.start_time,
            meetLink: booking.meet_link || null,
          });
        }
      } catch (mailErr) { console.warn('Confirmation email failed:', mailErr.message); }

      return res.status(200).json({ success: true, booking: updated[0] });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // SCRUM-88. The single point where somebody states what actually happened
  // in a lesson. Until this runs, delivery_status is null and the booking is
  // invisible to both the billing sweep and the payout sweep — no attestation,
  // no money moves in either direction.
  if (resource === 'mark-delivered') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    const caller = await requireAuth(req, res);
    if (!caller) return;
    const { bookingId, outcome, note } = req.body || {};
    if (!bookingId) return res.status(400).json({ error: 'bookingId required' });
    if (!isValidId(bookingId)) return res.status(400).json({ error: 'Invalid bookingId' });

    // 'late_cancelled' is deliberately not settable here — it is only ever
    // written by the cancellation path, which is the one place that can
    // measure notice against the lesson's start time. Letting it be posted
    // directly would make "the family cancelled late" an assertion anyone
    // could make after the fact rather than something the clock decided.
    //
    // Everything else a week of teaching actually throws up is settable, so
    // a tutor never has to choose between billing a family for a lesson that
    // didn't happen and leaving the booking unanswered forever. Which of
    // these bill is decided by the billing/payout sweeps, not here — see
    // BILLABLE_OUTCOMES in lib/cancellationPolicy.js.
    const OUTCOMES = ['delivered', 'partial', 'no_show', 'cancelled_mutual', 'tutor_cancelled', 'waived'];
    if (!OUTCOMES.includes(outcome)) {
      return res.status(400).json({ error: `outcome must be one of: ${OUTCOMES.join(', ')}` });
    }
    if (note != null && (typeof note !== 'string' || note.length > 500)) {
      return res.status(400).json({ error: 'note must be a string under 500 characters' });
    }

    try {
      const bookings = await dbGet(`/bookings?id=eq.${bookingId}&limit=1`);
      const booking = bookings[0];
      if (!booking) return res.status(404).json({ error: 'Booking not found' });

      const isAdmin = caller.role === 'admin';
      if (!isAdmin && !(await verifyTutorIdentity(caller, booking.tutor_name))) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      if (booking.status === 'requested') {
        return res.status(409).json({ error: 'This lesson was never confirmed.' });
      }
      // A lesson can't be attested before it has finished. Without this the
      // endpoint would just reintroduce the bug it exists to fix, one
      // booking at a time — marking a future lesson delivered would make it
      // billable ahead of actually happening.
      if (new Date(booking.end_time) > new Date()) {
        return res.status(409).json({ error: 'This lesson hasn\'t finished yet.' });
      }
      // Attestation is a one-time statement of fact by the tutor. Correcting
      // one is an admin job, because by then it may already have moved money.
      if (booking.delivery_status && !isAdmin) {
        return res.status(409).json({
          error: `Already marked "${booking.delivery_status}". Ask an admin to change it.`,
        });
      }
      // Once a booking has been paid out, its outcome is settled history —
      // re-marking it would desynchronise the tutor's earnings from what
      // they were actually transferred.
      if (booking.paid_out_at) {
        return res.status(409).json({ error: 'This lesson has already been paid out and can\'t be re-marked.' });
      }

      const { BILLABLE_OUTCOMES } = require('../lib/cancellationPolicy');
      const happened = ['delivered', 'partial', 'no_show'].includes(outcome);
      const patch = {
        delivery_status: outcome,
        delivery_marked_by: caller.email,
        // delivered_at means "when the slot was consumed". A lesson that was
        // cancelled or waived never consumed one, so it stays null rather
        // than recording a time nothing happened at.
        delivered_at: happened ? new Date().toISOString() : null,
      };
      if (note != null) patch.delivery_note = note;
      // status now says what happened to the lesson rather than doubling as
      // the payout marker (see the paid_out_at migration). A no-show still
      // concluded — the slot was held and consumed — so it lands on
      // 'completed' alongside a taught lesson; the cancellation outcomes
      // move the booking to 'cancelled', which is what they actually are.
      if (happened) patch.status = 'completed';
      else if (outcome === 'cancelled_mutual' || outcome === 'tutor_cancelled') patch.status = 'cancelled';

      const r = await supabaseRequest(`/bookings?id=eq.${bookingId}`, {
        method: 'PATCH', prefer: 'return=representation', body: JSON.stringify(patch),
      });
      const updated = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(updated));

      await logAdminAction({
        actor: caller.email, action: 'mark-delivered',
        targetType: 'booking', targetId: bookingId,
        details: { outcome, note: note || null, wasAdminOverride: isAdmin && !!booking.delivery_status },
      });
      return res.status(200).json({ success: true, booking: updated[0] });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // The tutor's "what do I still owe an answer on" queue, and the admin's
  // view of what is holding up billing.
  if (resource === 'awaiting-delivery') {
    const caller = await requireAuth(req, res);
    if (!caller) return;
    const { tutorName } = req.query;
    const isAdmin = caller.role === 'admin';
    if (!isAdmin) {
      if (!tutorName || !(await verifyTutorIdentity(caller, tutorName))) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }
    try {
      const scope = tutorName ? `tutor_name=eq.${encodeURIComponent(tutorName)}&` : '';
      const bookings = await dbGet(
        `/bookings?${scope}delivery_status=is.null&status=neq.requested` +
        `&end_time=lte.${new Date().toISOString()}&order=start_time.asc`
      );
      return res.status(200).json({ bookings });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (resource === 'self-cancel-booking') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    const caller = await requireAuth(req, res);
    if (!caller) return;
    const { bookingId } = req.body || {};
    if (!bookingId) return res.status(400).json({ error: 'bookingId required' });
    if (!isValidId(bookingId)) return res.status(400).json({ error: 'Invalid bookingId' });
    try {
      const bookings = await dbGet(`/bookings?id=eq.${bookingId}&limit=1`);
      const booking = bookings[0];
      if (!booking) return res.status(404).json({ error: 'Booking not found' });
      if (!(await verifyTutorIdentity(caller, booking.tutor_name))) return res.status(403).json({ error: 'Forbidden' });
      if (booking.status === 'cancelled') return res.status(409).json({ error: 'This lesson is already cancelled.' });
      if (new Date(booking.start_time) <= new Date()) {
        return res.status(409).json({ error: 'This lesson has already happened and can\'t be cancelled.' });
      }

      let refundResult = { refunded: false };
      let refundError = null;
      try {
        refundResult = await refundBooking(booking, { reason: 'requested_by_customer' });
      } catch(refundErr) {
        console.warn('Self-cancel refund failed:', refundErr.message);
        refundError = refundErr.message;
      }
      // SCRUM-88: the tutor is withdrawing from their own lesson, so the
      // 18-hour notice rule never applies — it exists to protect the tutor's
      // held time, not to charge a family for a lesson the tutor pulled out
      // of. Marked 'waived' rather than left null so the booking is settled
      // and the billing sweep has nothing to reconsider.
      const patch = { status: 'cancelled', delivery_status: 'waived',
                      delivery_marked_by: caller.email,
                      delivery_note: 'Cancelled by tutor — not charged to the family.' };
      if (refundResult.refunded) patch.payment_status = 'refunded';
      await supabaseRequest(`/bookings?id=eq.${bookingId}`, {
        method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(patch),
      });
      await logAdminAction({ actor: caller.email, action: 'self-cancel-booking', targetType: 'booking', targetId: bookingId });
      return res.status(200).json({ success: true, refunded: refundResult.refunded, refundError });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  if (resource === 'self-reschedule-booking') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    const caller = await requireAuth(req, res);
    if (!caller) return;
    const { bookingId, newStartTime } = req.body || {};
    if (!bookingId || !newStartTime) return res.status(400).json({ error: 'bookingId and newStartTime required' });
    if (!isValidId(bookingId)) return res.status(400).json({ error: 'Invalid bookingId' });
    try {
      const bookings = await dbGet(`/bookings?id=eq.${bookingId}&limit=1`);
      const booking = bookings[0];
      if (!booking) return res.status(404).json({ error: 'Booking not found' });
      if (!(await verifyTutorIdentity(caller, booking.tutor_name))) return res.status(403).json({ error: 'Forbidden' });
      if (booking.status === 'cancelled') return res.status(409).json({ error: 'This lesson is already cancelled.' });
      if (new Date(booking.start_time) <= new Date()) {
        return res.status(409).json({ error: 'This lesson has already happened and can\'t be rescheduled.' });
      }
      // Shift end_time by the same delta so duration_mins stays accurate —
      // the admin equivalent (analytics.js reschedule-booking) doesn't do
      // this, but there's no reason a lesson's length should silently
      // change just because it moved.
      const newStart = new Date(newStartTime);
      const newEnd = booking.end_time
        ? new Date(newStart.getTime() + (new Date(booking.end_time) - new Date(booking.start_time)))
        : null;
      const r = await supabaseRequest(`/bookings?id=eq.${bookingId}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: JSON.stringify({ start_time: newStart.toISOString(), ...(newEnd ? { end_time: newEnd.toISOString() } : {}) }),
      });
      if (!r.ok) { const d = await r.json(); throw new Error(JSON.stringify(d)); }
      await logAdminAction({ actor: caller.email, action: 'self-reschedule-booking', targetType: 'booking', targetId: bookingId });
      return res.status(200).json({ success: true });
    } catch(e) {
      if (e.message.includes('bookings_no_tutor_overlap')) {
        return res.status(409).json({ error: 'You\'re already booked at that time. Please choose a different slot.', conflict: true });
      }
      return res.status(500).json({ error: e.message });
    }
  }

  // In-platform messaging was removed entirely (SCRUM-49/SCRUM-55) —
  // replaced with direct email/WhatsApp contact between parent and tutor,
  // not built or stored on the platform.
  const validResources = ['notes', 'homework', 'progress'];
  if (!validResources.includes(resource)) {
    return res.status(400).json({ error: 'Invalid resource' });
  }

  const table = resource === 'notes' ? 'lesson_notes' : resource;

  // Previously none of notes/homework/progress checked who was calling —
  // any caller who knew or guessed a studentId could read or write another
  // family's private tutoring data (SCRUM-13).
  const caller = await requireAuth(req, res);
  if (!caller) return;

  try {
    // ── GET — list by student ─────────────────────────────────────────
    if (req.method === 'GET') {
      const { studentId, studentEmail } = req.query;
      let sid = studentId;
      // Allow lookup by email, but only the caller's OWN email — otherwise
      // anyone could read another family's notes/homework/progress just by
      // knowing their email address.
      if (!sid && studentEmail) {
        if (studentEmail.toLowerCase() !== caller.email.toLowerCase() && caller.role !== 'admin') {
          return res.status(403).json({ error: 'Forbidden' });
        }
        const students = await dbGet(`/students?parent_email=eq.${encodeURIComponent(normalizeEmail(studentEmail))}&limit=1`);
        if (!students.length) return res.status(200).json([]);
        sid = students[0].id;
      }
      if (!sid) return res.status(400).json({ error: 'studentId or studentEmail required' });
      if (!isValidId(sid)) return res.status(400).json({ error: 'Invalid studentId' });
      if (!(await verifyStudentAccess(caller, sid))) return res.status(403).json({ error: 'Forbidden' });

      let order = 'created_at.desc';
      if (resource === 'progress') order = 'updated_at.desc';
      const data = await dbGet(`/${table}?student_id=eq.${sid}&order=${order}`);
      return res.status(200).json(data);
    }

    // ── POST — create ─────────────────────────────────────────────────
    if (req.method === 'POST') {
      const body = req.body || {};
      // Only the student's actual assigned tutor (or an admin) can set
      // notes/homework/progress — a parent viewing their own child's data
      // is a different privilege from a tutor writing to it.
      if (caller.role !== 'admin') {
        if (!body.studentId || !isValidId(body.studentId)) {
          return res.status(400).json({ error: 'Invalid studentId' });
        }
        const callerProfile = await dbGet(`/profiles?id=eq.${caller.id}&select=tutor_name&limit=1`);
        const myTutorName = callerProfile[0]?.tutor_name;
        const ownBookings = myTutorName
          ? await dbGet(`/bookings?student_id=eq.${body.studentId}&tutor_name=eq.${encodeURIComponent(myTutorName)}&limit=1`)
          : [];
        if (!ownBookings.length) return res.status(403).json({ error: 'Forbidden' });
      }
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

      return res.status(201).json({ success: true, record: created });
    }

    // ── PATCH — update (homework completion, message read) ────────────
    if (req.method === 'PATCH') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      if (!isValidId(id)) return res.status(400).json({ error: 'Invalid id' });
      // The row's own student_id is the source of truth for ownership —
      // called by both the tutor (marking things) and the student's parent
      // (marking homework complete), so check against whichever student
      // this specific row actually belongs to rather than trusting the body.
      const existingRows = await dbGet(`/${table}?id=eq.${id}&select=student_id&limit=1`);
      const rowStudentId = existingRows[0]?.student_id;
      if (!rowStudentId) return res.status(404).json({ error: 'Not found' });
      if (!(await verifyStudentAccess(caller, rowStudentId))) return res.status(403).json({ error: 'Forbidden' });
      const updates = {};
      if (resource === 'homework') {
        if (typeof req.body.completed === 'boolean') {
          updates.completed = req.body.completed;
          updates.completed_at = req.body.completed ? new Date().toISOString() : null;
        }
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
