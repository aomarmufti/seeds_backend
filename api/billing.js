// api/billing.js
// GET  /api/billing?resource=payment-methods&customerId=cus_xxx  — list saved cards
// POST /api/billing { resource: 'payment-methods', action: 'detach', paymentMethodId }
// POST /api/billing { resource: 'customer-portal', customerId, returnUrl }
//
// Parent-facing self-service billing endpoints, combined into one file
// (Vercel's Hobby plan caps a deployment at 12 serverless functions and
// this repo is at that limit — grouping related small endpoints avoids
// adding a function per tiny piece of functionality).

const { applyCors } = require('../lib/cors');
const { getPaymentService } = require('../lib/payments');
const { requireAuth } = require('../lib/auth');
const { requireCronSecret } = require('../lib/cronAuth');
const { dbGet, dbPost, dbPatch } = require('../lib/db');
const { normalizeEmail } = require('../lib/validate');
const { logError, alertCritical } = require('../lib/logger');

// Confirms the authenticated caller owns this Stripe customer id (their own
// students.stripe_customer_id), unless they're an admin. Returns true/false;
// callers are responsible for responding with 403 on false.
async function callerOwnsCustomer(caller, customerId) {
  if (caller.role === 'admin') return true;
  if (!customerId) return false;
  const students = await dbGet(
    `/students?parent_email=eq.${encodeURIComponent(normalizeEmail(caller.email))}&stripe_customer_id=eq.${encodeURIComponent(customerId)}&limit=1`
  );
  return students.length > 0;
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  // Vercel's cron scheduler issues a GET with no user session at all
  // (Authorization: Bearer $CRON_SECRET instead of a JWT) — must be
  // checked before requireAuth, which would otherwise reject it as
  // unauthenticated. Gated on GET (like every other ?resource= branch in
  // this file) so POST callers, which carry their resource in the body
  // instead, never need req.query populated at all.
  if (req.method === 'GET' && req.query && req.query.resource === 'billing-cron') {
    return handleBillingCron(req, res);
  }

  const caller = await requireAuth(req, res);
  if (!caller) return;

  if (req.method === 'GET' && req.query.resource === 'billing-cycle') {
    try {
      const email = normalizeEmail(caller.email);
      const students = await dbGet(`/students?parent_email=eq.${encodeURIComponent(email)}&select=billing_cycle&limit=1`);
      return res.status(200).json({ billingCycle: students[0]?.billing_cycle || 'weekly' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // A family's own periodic billing batches — replaces per-booking payment
  // status as the source of truth for "what have I actually been charged,
  // and what do I still owe" now that payment is deferred to the billing
  // cycle rather than tied to each individual lesson.
  if (req.method === 'GET' && req.query.resource === 'billing-history') {
    try {
      let studentIds;
      if (caller.role === 'admin' && req.query.studentId) {
        studentIds = [req.query.studentId];
      } else {
        const email = normalizeEmail(caller.email);
        const students = await dbGet(`/students?parent_email=eq.${encodeURIComponent(email)}&select=id`);
        studentIds = students.map(s => s.id);
      }
      if (!studentIds.length) return res.status(200).json({ batches: [], lessons: [] });
      const batches = await dbGet(`/billing_batches?student_id=in.(${studentIds.join(',')})&order=created_at.desc`);
      // Per-lesson breakdown (SCRUM-75) — batches alone tell a family "this
      // week is paid" but not which specific lesson(s) that covered. Free
      // consultations/trials are excluded (fee_pence=gt.0) since they're
      // never billed and would just show as permanently "unbilled" noise.
      const bookings = await dbGet(
        `/bookings?student_id=in.(${studentIds.join(',')})&fee_pence=gt.0&status=neq.cancelled` +
        `&select=id,subject,tutor_name,lesson_type,start_time,fee_pence,payment_status,billing_batch_id&order=start_time.desc`
      );
      return res.status(200).json({
        batches: batches.map(b => ({
          id: b.id, cycle: b.cycle,
          periodStart: b.period_start, periodEnd: b.period_end,
          totalPence: b.total_pence, status: b.status,
          paymentLink: b.payment_link, paidAt: b.paid_at,
        })),
        lessons: bookings.map(b => ({
          id: b.id, subject: b.subject, tutorName: b.tutor_name, lessonType: b.lesson_type,
          startTime: b.start_time, feePence: b.fee_pence,
          paymentStatus: b.payment_status, billingBatchId: b.billing_batch_id,
        })),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  let payments;
  try {
    payments = getPaymentService();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  if (req.method === 'GET' && req.query.resource === 'payment-methods') {
    const { customerId } = req.query;
    if (!customerId) return res.status(400).json({ error: 'customerId required' });
    if (!(await callerOwnsCustomer(caller, customerId))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    try {
      const methods = await payments.listPaymentMethods(customerId);
      return res.status(200).json(methods.map(m => ({
        id: m.id,
        brand: m.card?.brand,
        last4: m.card?.last4,
        expMonth: m.card?.exp_month,
        expYear: m.card?.exp_year,
      })));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    const { resource } = req.body || {};

    if (resource === 'billing-cycle') {
      const { billingCycle } = req.body;
      if (!['weekly', 'monthly'].includes(billingCycle)) {
        return res.status(400).json({ error: 'billingCycle must be "weekly" or "monthly"' });
      }
      try {
        const email = normalizeEmail(caller.email);
        const students = await dbGet(`/students?parent_email=eq.${encodeURIComponent(email)}&limit=1`);
        if (!students.length) return res.status(404).json({ error: 'No student record found for this account' });
        await dbPatch(`/students?parent_email=eq.${encodeURIComponent(email)}`, { billing_cycle: billingCycle });
        return res.status(200).json({ success: true, billingCycle });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    if (resource === 'payment-methods') {
      const { action, paymentMethodId, customerId } = req.body;
      if (action !== 'detach') return res.status(400).json({ error: 'Unknown action' });
      if (!paymentMethodId || !customerId) return res.status(400).json({ error: 'paymentMethodId and customerId required' });
      if (!(await callerOwnsCustomer(caller, customerId))) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      try {
        // Confirm the payment method actually belongs to the customer the
        // caller was verified to own, not just any paymentMethodId they pass.
        const methods = await payments.listPaymentMethods(customerId);
        if (!methods.some(m => m.id === paymentMethodId)) {
          return res.status(403).json({ error: 'Forbidden' });
        }
        await payments.detachPaymentMethod(paymentMethodId);
        return res.status(200).json({ success: true });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // Lets a logged-in student/parent add a card independently of booking a
    // lesson — previously the ONLY way to end up with a saved card was via
    // the public wizard's paid-lesson flow, and even then the resulting
    // Stripe customer id was never written back onto the student's row, so
    // "saved cards" could never actually be listed for anyone afterwards.
    // Idempotent: reuses the existing Stripe customer if this student
    // already has one, rather than creating a duplicate on every click.
    if (resource === 'setup-intent') {
      try {
        const email = normalizeEmail(caller.email);
        const existing = await dbGet(`/students?parent_email=eq.${encodeURIComponent(email)}&limit=1`);
        let student = existing[0];
        if (!student) {
          student = await dbPost('/students', {
            parent_name: caller.email, parent_email: email, student_name: caller.email,
          });
        }
        let customerId = student.stripe_customer_id;
        if (!customerId) {
          const customer = await payments.createCustomer({ email: caller.email, name: student.parent_name || caller.email });
          customerId = customer.id;
          await dbPatch(`/students?id=eq.${student.id}`, { stripe_customer_id: customerId });
        }
        const setupIntent = await payments.createSetupIntent({ customerId, metadata: { parentEmail: caller.email } });
        return res.status(200).json({ clientSecret: setupIntent.client_secret, customerId });
      } catch (err) {
        console.error('Setup intent error:', err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    if (resource === 'customer-portal') {
      // Requires the Customer Portal to be configured once in the Stripe
      // Dashboard (Settings -> Billing -> Customer portal) — which
      // features are enabled, business branding, etc. That's a one-time
      // manual setup step in the Stripe account, not something this
      // endpoint can do.
      const { customerId, returnUrl } = req.body;
      if (!customerId) return res.status(400).json({ error: 'customerId required' });
      if (!(await callerOwnsCustomer(caller, customerId))) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      try {
        const session = await payments.createCustomerPortalSession({
          customerId,
          returnUrl: returnUrl || process.env.FRONTEND_URL || 'https://seedsinstitute.co.uk',
        });
        return res.status(200).json({ url: session.url });
      } catch (err) {
        console.error('Customer portal error:', err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    return res.status(400).json({ error: 'Unknown resource' });
  }

  res.status(405).json({ error: 'Method not allowed' });
};

// ── PERIODIC BILLING (Vercel cron, daily) ─────────────────────────────────
// Replaces the old book-now-pay-now model: a family is charged once per
// their own billing_cycle (weekly every Monday, monthly on the 1st) for
// every lesson that has actually happened since it was last billed, rather
// than being charged (or emailed a payment link) the moment each lesson is
// booked. Runs daily so it can check both cadences; a family is only ever
// billed on the day matching their own cycle, never twice for the same day.
async function handleBillingCron(req, res) {
  if (!requireCronSecret(req, res)) return;
  let payments;
  try {
    payments = getPaymentService();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const today = new Date();
  const cyclesDueToday = [];
  if (today.getUTCDay() === 1) cyclesDueToday.push('weekly'); // every Monday
  if (today.getUTCDate() === 1) cyclesDueToday.push('monthly'); // 1st of month
  if (!cyclesDueToday.length) {
    return res.status(200).json({ success: true, processed: 0, note: 'Not a billing day for either cycle' });
  }

  const results = [];
  try {
    for (const cycle of cyclesDueToday) {
      const students = await dbGet(`/students?billing_cycle=eq.${cycle}`);
      for (const student of students) {
        try {
          const outcome = await billStudentBatch(student, cycle, payments);
          if (outcome) results.push({ studentId: student.id, cycle, ...outcome });
        } catch (err) {
          logError('billing.billing-cron.student', err);
          results.push({ studentId: student.id, cycle, status: 'error', error: err.message });
        }
      }
    }
    const failed = results.filter(r => r.status === 'failed' || r.status === 'error');
    if (failed.length) {
      await alertCritical('Periodic billing had failures', `${failed.length}/${results.length} batches failed: ${JSON.stringify(failed)}`);
    }
    return res.status(200).json({ success: true, processed: results.length, results });
  } catch (err) {
    logError('billing.billing-cron', err);
    return res.status(500).json({ error: err.message });
  }
}

// Bills a single family for every unbilled, already-happened lesson: charges
// their saved card off-session if they have one, otherwise emails a Stripe
// Checkout payment link for the batch total. Returns null if nothing is due.
async function billStudentBatch(student, cycle, payments) {
  const nowIso = new Date().toISOString();
  const bookings = await dbGet(
    `/bookings?student_id=eq.${student.id}&payment_status=eq.unbilled&fee_pence=gt.0` +
    `&status=neq.cancelled&start_time=lte.${nowIso}&order=start_time.asc`
  );
  if (!bookings.length) return { status: 'nothing_due' };

  const totalPence = bookings.reduce((s, b) => s + b.fee_pence, 0);
  const batch = await dbPost('/billing_batches', {
    student_id: student.id, cycle,
    period_start: bookings[0].start_time, period_end: nowIso,
    total_pence: totalPence, status: 'pending',
  });
  const bookingIdList = bookings.map(b => b.id).join(',');
  const lessonWord = bookings.length === 1 ? 'lesson' : 'lessons';

  if (student.stripe_customer_id) {
    try {
      const methods = await payments.listPaymentMethods(student.stripe_customer_id);
      const savedPM = methods[0];
      if (savedPM) {
        const pi = await payments.createPaymentIntent({
          amount: totalPence,
          customerId: student.stripe_customer_id,
          paymentMethodId: savedPM.id,
          confirm: true,
          offSession: true,
          description: `Seeds Tuition — ${cycle} billing — ${bookings.length} ${lessonWord}`,
          receiptEmail: student.parent_email,
          metadata: { billingBatchId: batch.id, studentId: student.id },
          idempotencyKey: `billing-batch:${batch.id}`,
        });
        await dbPatch(`/billing_batches?id=eq.${batch.id}`, {
          status: 'paid', stripe_payment_intent_id: pi.id, paid_at: new Date().toISOString(),
        });
        await dbPatch(`/bookings?id=in.(${bookingIdList})`, { payment_status: 'paid', billing_batch_id: batch.id });
        return { status: 'charged', batchId: batch.id, totalPence, lessons: bookings.length };
      }
    } catch (chargeErr) {
      // Declined card or other off-session charge failure — fall through
      // to the payment-link email below rather than leaving the family
      // silently unbilled.
      console.warn(`Batch charge failed for student ${student.id}:`, chargeErr.message);
    }
  }

  // No saved card, or the off-session charge failed — email a Checkout
  // payment link for the whole batch instead.
  try {
    const frontendUrl = process.env.FRONTEND_URL || 'https://seedsinstitute.co.uk';
    const session = await payments.createCheckoutSession({
      customerId: student.stripe_customer_id || undefined,
      customerEmail: student.stripe_customer_id ? undefined : student.parent_email,
      amount: totalPence,
      description: `Seeds Tuition — ${cycle} billing — ${bookings.length} ${lessonWord}`,
      successUrl: `${frontendUrl}/?billing=success&batch=${batch.id}`,
      cancelUrl: `${frontendUrl}/?billing=cancelled&batch=${batch.id}`,
      metadata: { billingBatchId: batch.id, studentId: student.id },
    });
    await dbPatch(`/billing_batches?id=eq.${batch.id}`, {
      status: 'payment_link_sent', stripe_checkout_session_id: session.id, payment_link: session.url,
    });
    await dbPatch(`/bookings?id=in.(${bookingIdList})`, { payment_status: 'invoiced', billing_batch_id: batch.id });
    await sendBatchPaymentLinkEmail(student, bookings.length, totalPence, session.url);
    return { status: 'payment_link_sent', batchId: batch.id, totalPence, lessons: bookings.length };
  } catch (linkErr) {
    await dbPatch(`/billing_batches?id=eq.${batch.id}`, { status: 'failed' });
    await dbPatch(`/bookings?id=in.(${bookingIdList})`, { payment_status: 'failed', billing_batch_id: batch.id });
    return { status: 'failed', batchId: batch.id, error: linkErr.message };
  }
}

async function sendBatchPaymentLinkEmail(student, lessonCount, totalPence, checkoutUrl) {
  if (!student.parent_email) return;
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: 'smtp.resend.com', port: 587, secure: false,
      auth: { user: 'resend', pass: process.env.RESEND_API_KEY },
    });
    const amountStr = `£${(totalPence / 100).toFixed(2)}`;
    const lessonWord = lessonCount === 1 ? 'lesson' : 'lessons';
    await transporter.sendMail({
      from: `"Seeds Tuition" <${process.env.EMAIL_FROM}>`,
      to: student.parent_email,
      subject: `Your Seeds billing statement — ${amountStr}`,
      html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f5f5f0;margin:0;padding:24px">
        <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden">
          <div style="background:#0D1B2A;padding:24px 28px">
            <h1 style="font-family:Georgia,serif;color:#fff;margin:0;font-size:22px">Seeds Tuition</h1>
          </div>
          <div style="padding:24px 28px">
            <h2 style="font-family:Georgia,serif;color:#0D1B2A;margin-bottom:8px">Your billing statement is ready</h2>
            <p style="color:#4A5568;font-size:15px">Hi ${student.parent_name || student.student_name || ''},</p>
            <p style="color:#4A5568;font-size:15px">${lessonCount} ${lessonWord} completed this billing period — please pay to keep your account up to date.</p>
            <div style="background:#FAF8F4;border-radius:10px;padding:14px 16px;margin:18px 0;font-size:14px">
              <div style="display:flex;justify-content:space-between"><span style="color:#718096">Total due</span><span style="font-weight:700;color:#0D1B2A">${amountStr}</span></div>
            </div>
            <a href="${checkoutUrl}" style="display:block;background:#0D1B2A;color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:10px;font-weight:700;font-size:15px;margin-bottom:16px">Pay ${amountStr} now →</a>
            <p style="font-size:12px;color:#A7A7A7">Secured by Stripe. Your card details are never stored on Seeds' servers.</p>
          </div>
        </div>
      </body></html>`,
    });
  } catch (emailErr) {
    console.warn('Batch payment-link email failed:', emailErr.message);
  }
}
