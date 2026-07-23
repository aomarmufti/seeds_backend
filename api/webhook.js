// api/webhook.js
// POST /api/webhook
// Single webhook receiver for both Stripe and Calendly, dispatched by
// which signature header is present. Combined into one file/one
// Vercel serverless function — Vercel's Hobby plan caps a deployment
// at 12 functions, and this repo has grown close to that limit, so
// webhook receivers (naturally similar in shape: verify signature,
// dedup, handle event) are consolidated rather than one-file-per-source.
// Vercel note: webhooks need the RAW body for signature verification,
// so body parsing is disabled for this route via the config export below.

const getRawBody = require('raw-body');
const { getPaymentService } = require('../lib/payments');
const { dbGet, dbPost, supabaseRequest } = require('../lib/db');
const { resolvePrice } = require('../lib/pricing');
const { verifyWebhookSignature: verifyCalendlySignature, parseInviteeCreatedPayload } = require('../lib/calendly');
const { getMeetingLink } = require('../lib/tutors');

module.exports.config = {
  api: { bodyParser: false },
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawBody = await getRawBody(req);

  if (req.headers['stripe-signature']) {
    return handleStripeWebhook(req, res, rawBody);
  }
  if (req.headers['calendly-webhook-signature']) {
    return handleCalendlyWebhook(req, res, rawBody);
  }
  return res.status(400).json({ error: 'Unrecognised webhook source (no known signature header)' });
};

// ── Stripe ───────────────────────────────────────────────────────────────

async function handleStripeWebhook(req, res, rawBody) {
  let payments;
  try {
    payments = getPaymentService();
  } catch (err) {
    return res.status(500).json({ error: 'Stripe webhook not configured' });
  }

  let event;
  try {
    event = payments.constructWebhookEvent(rawBody, req.headers['stripe-signature']);
  } catch (err) {
    console.error('Stripe webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Idempotency: Stripe can and does redeliver the same event. Record the
  // event id first; a unique-constraint conflict means we've already
  // processed it, so skip re-running side effects.
  try {
    const dedupRes = await supabaseRequest('/stripe_webhook_events', {
      method: 'POST',
      prefer: 'return=minimal',
      body: JSON.stringify({ event_id: event.id, event_type: event.type }),
    });
    if (!dedupRes.ok) {
      if (dedupRes.status === 409) {
        return res.status(200).json({ received: true, duplicate: true });
      }
      const errBody = await dedupRes.json().catch(() => ({}));
      throw new Error(errBody.message || `Dedup insert failed with status ${dedupRes.status}`);
    }
  } catch (err) {
    console.error('Stripe webhook dedup check failed:', err.message);
    return res.status(500).json({ error: 'Webhook dedup check failed' });
  }

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      console.log(`✅ Payment succeeded: ${pi.id} — £${pi.amount / 100}`);
      if (pi.metadata && pi.metadata.bookingId) {
        await supabaseRequest(`/bookings?id=eq.${pi.metadata.bookingId}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ stripe_payment_intent_id: pi.id, status: 'confirmed' }),
        });
      }
      break;
    }
    case 'checkout.session.completed': {
      // Student paid via Stripe Checkout (either the legacy payment-link
      // flow or the Calendly-scheduled-then-pay flow — both set
      // metadata.bookingId when creating the session).
      const session = event.data.object;
      if (session.metadata && session.metadata.bookingId) {
        await supabaseRequest(`/bookings?id=eq.${session.metadata.bookingId}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({
            stripe_payment_intent_id: session.payment_intent,
            status: 'confirmed',
            payment_link: null, // clear the link — it's been paid
          }),
        });
        console.log(`✅ Checkout paid: booking ${session.metadata.bookingId}`);

        try {
          const rows = await dbGet(
            `/bookings?id=eq.${session.metadata.bookingId}&select=*,students(student_name,parent_name,parent_email,parent_phone)`
          );
          const booking = rows[0];
          if (booking && booking.students) {
            const { sendBookingConfirmation } = require('../lib/reminders');
            await sendBookingConfirmation({
              studentName: booking.students.student_name,
              parentName: booking.students.parent_name,
              parentEmail: booking.students.parent_email,
              parentPhone: booking.students.parent_phone,
              tutorName: booking.tutor_name,
              subject: booking.subject,
              lessonType: booking.lesson_type,
              startTime: booking.start_time,
              durationMins: booking.duration_mins,
              meetingLink: booking.meet_link,
              amountPence: booking.fee_pence,
              paymentIntentId: session.payment_intent,
            });
          }
        } catch (emailErr) {
          // Booking is confirmed and paid regardless of whether the email
          // sends — don't fail the webhook (Stripe would just retry it).
          console.error('Booking confirmation email failed:', emailErr.message);
        }
      }
      break;
    }
    case 'checkout.session.expired': {
      // Student didn't complete payment within the session's time limit.
      const session = event.data.object;
      if (session.metadata && session.metadata.bookingId) {
        await supabaseRequest(`/bookings?id=eq.${session.metadata.bookingId}&status=eq.scheduled`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ status: 'payment_failed' }),
        });
        console.warn(`⌛ Checkout session expired unpaid: booking ${session.metadata.bookingId}`);
      }
      break;
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object;
      console.error(`❌ Payment failed: ${pi.id} — ${pi.last_payment_error?.message}`);
      if (pi.metadata && pi.metadata.bookingId) {
        await supabaseRequest(`/bookings?id=eq.${pi.metadata.bookingId}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ status: 'payment_failed' }),
        });
      }
      break;
    }
    case 'setup_intent.succeeded': {
      const si = event.data.object;
      console.log(`💳 Card saved: customer ${si.customer}`);
      break;
    }
    default:
      break;
  }

  res.status(200).json({ received: true });
}

// ── Calendly ─────────────────────────────────────────────────────────────
// invitee.created creates the bookings row (status='scheduled') and, for
// paid lesson types, a Stripe Checkout session + payment-link email. Free
// trials skip straight to 'confirmed' since there's nothing to pay.
// invitee.canceled cancels the linked booking.
//
// Not verified against a live Calendly account/webhook in this
// environment — written to the documented v2 API/webhook payload shape.

async function handleCalendlyWebhook(req, res, rawBody) {
  if (!process.env.CALENDLY_WEBHOOK_SIGNING_KEY) {
    return res.status(500).json({ error: 'Calendly webhook not configured' });
  }

  try {
    verifyCalendlySignature(rawBody.toString('utf8'), req.headers['calendly-webhook-signature'], process.env.CALENDLY_WEBHOOK_SIGNING_KEY);
  } catch (err) {
    console.error('Calendly webhook signature failed:', err.message);
    return res.status(400).json({ error: err.message });
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  const { event, payload } = body || {};
  if (!payload) return res.status(400).json({ error: 'Missing payload' });

  // Idempotency: Calendly's payload doesn't include a single canonical
  // event id the way Stripe's does, so the invitee URI + event name is
  // the most stable dedup key available (an invitee can only be created
  // or cancelled once each).
  const dedupKey = `${payload.uri || 'unknown'}:${event}`;
  try {
    const dedupRes = await supabaseRequest('/calendly_webhook_events', {
      method: 'POST',
      prefer: 'return=minimal',
      body: JSON.stringify({ event_id: dedupKey, event_type: event }),
    });
    if (!dedupRes.ok) {
      if (dedupRes.status === 409) return res.status(200).json({ received: true, duplicate: true });
      const errBody = await dedupRes.json().catch(() => ({}));
      throw new Error(errBody.message || `Dedup insert failed with status ${dedupRes.status}`);
    }
  } catch (err) {
    console.error('Calendly webhook dedup check failed:', err.message);
    return res.status(500).json({ error: 'Webhook dedup check failed' });
  }

  try {
    if (event === 'invitee.created') {
      await handleInviteeCreated(payload);
    } else if (event === 'invitee.canceled') {
      await handleInviteeCanceled(payload);
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Calendly webhook handling failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function handleInviteeCreated(payload) {
  const parsed = parseInviteeCreatedPayload(payload);
  if (!parsed.trackingId) {
    // Booked directly on a tutor's Calendly page without going through
    // our lead flow — nothing to reconcile against, so just log it for
    // manual follow-up rather than guessing at a booking record.
    console.warn('Calendly invitee.created with no tracking id — skipping automatic booking creation', parsed.eventUri);
    return;
  }

  const leads = await dbGet(`/leads?id=eq.${parsed.trackingId}&limit=1`);
  const lead = leads[0];
  if (!lead) {
    console.warn(`Calendly invitee.created references unknown lead ${parsed.trackingId}`);
    return;
  }

  // A booked event type can be either the regular-lesson link or the
  // initial-consultation link (SCRUM-55 follow-up) — check both columns
  // rather than assuming it's always the same one.
  const encodedEventTypeUri = encodeURIComponent(parsed.eventTypeUri);
  const [byLessonUri, byTrialUri] = await Promise.all([
    dbGet(`/profiles?calendly_event_type_uri=eq.${encodedEventTypeUri}&limit=1`),
    dbGet(`/profiles?calendly_trial_event_type_uri=eq.${encodedEventTypeUri}&limit=1`),
  ]);
  const tutorName = byLessonUri[0]?.tutor_name || byTrialUri[0]?.tutor_name || lead.assigned_tutor;
  if (!tutorName) {
    console.warn(`Calendly invitee.created: no tutor resolved for event type ${parsed.eventTypeUri}`);
    return;
  }

  const durationMins = Math.round((new Date(parsed.endTime) - new Date(parsed.startTime)) / 60000) || 55;
  const lessonType = lead.notes && /trial/i.test(lead.notes) ? 'trial' : (lead.level === 'alevel' ? 'alevel' : 'gcse');
  const pricing = resolvePrice(lessonType, lead.level);
  const meetingLink = await getMeetingLink(tutorName);

  const existingStudents = await dbGet(`/students?parent_email=eq.${encodeURIComponent(lead.email)}&limit=1`);
  const student = existingStudents.length
    ? existingStudents[0]
    : await dbPost('/students', { parent_name: lead.name, parent_email: lead.email, student_name: lead.name });

  const isFree = pricing.amount === 0;
  const booking = await dbPost('/bookings', {
    student_id: student.id,
    tutor_name: tutorName,
    subject: lead.subject,
    lesson_type: lessonType,
    start_time: parsed.startTime,
    duration_mins: durationMins,
    fee_pence: pricing.amount,
    status: isFree ? 'confirmed' : 'scheduled',
    meet_link: meetingLink,
    calendly_event_uri: parsed.eventUri,
    calendly_invitee_uri: parsed.inviteeUri,
  });

  await supabaseRequest(`/leads?id=eq.${lead.id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ status: 'confirmed' }),
  });

  if (isFree) {
    const { sendBookingConfirmation } = require('../lib/reminders');
    await sendBookingConfirmation({
      studentName: lead.name, parentName: lead.name, parentEmail: lead.email,
      tutorName, subject: lead.subject, lessonType, studentLevel: lead.level,
      startTime: parsed.startTime, durationMins, meetingLink, amountPence: 0,
    });
    return;
  }

  const frontendUrl = process.env.FRONTEND_URL || 'https://seedsinstitute.co.uk';
  const payments = getPaymentService();
  const session = await payments.createCheckoutSession({
    customerEmail: lead.email,
    amount: pricing.amount,
    description: `${pricing.label} — ${lead.name} — ${tutorName}`,
    successUrl: `${frontendUrl}/?payment=success&booking=${booking.id}`,
    cancelUrl: `${frontendUrl}/?payment=cancelled&booking=${booking.id}`,
    metadata: { bookingId: booking.id },
  });

  await supabaseRequest(`/bookings?id=eq.${booking.id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ stripe_checkout_session_id: session.id, payment_link: session.url }),
  });

  const { sendPaymentLink } = require('../lib/reminders');
  await sendPaymentLink({
    parentName: lead.name, parentEmail: lead.email,
    studentName: lead.name, tutorName, subject: lead.subject,
    startTime: parsed.startTime, amountPence: pricing.amount,
    checkoutUrl: session.url,
  });
}

async function handleInviteeCanceled(payload) {
  const parsed = parseInviteeCreatedPayload(payload);
  if (!parsed.inviteeUri) return;
  await supabaseRequest(
    `/bookings?calendly_invitee_uri=eq.${encodeURIComponent(parsed.inviteeUri)}&status=in.(scheduled,confirmed)`,
    { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'cancelled' }) }
  );
}
