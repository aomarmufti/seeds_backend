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
const { logError, alertCritical } = require('../lib/logger');
const { normalizeEmail } = require('../lib/validate');

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
    logError('webhook.stripe.signature', err);
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
    logError('webhook.stripe.dedup', err);
    return res.status(500).json({ error: 'Webhook dedup check failed' });
  }

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      console.log(`✅ Payment succeeded: ${pi.id} — £${pi.amount / 100}`);
      if (pi.metadata && pi.metadata.billingBatchId) {
        await markBillingBatchPaid(pi.metadata.billingBatchId, pi.id);
        break;
      }
      if (pi.metadata && pi.metadata.bookingId) {
        await supabaseRequest(`/bookings?id=eq.${pi.metadata.bookingId}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ stripe_payment_intent_id: pi.id, status: 'confirmed', payment_status: 'paid' }),
        });
      }
      break;
    }
    case 'checkout.session.completed': {
      // Student paid via Stripe Checkout (either an ad-hoc single-booking
      // payment link — charge-student's no-saved-card fallback — or a
      // periodic billing batch, distinguished by which metadata key is set).
      const session = event.data.object;
      if (session.metadata && session.metadata.billingBatchId) {
        await markBillingBatchPaid(session.metadata.billingBatchId, session.payment_intent);
        break;
      }
      if (session.metadata && session.metadata.bookingId) {
        await supabaseRequest(`/bookings?id=eq.${session.metadata.bookingId}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({
            stripe_payment_intent_id: session.payment_intent,
            status: 'confirmed',
            payment_status: 'paid',
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
      if (session.metadata && session.metadata.billingBatchId) {
        await supabaseRequest(`/billing_batches?id=eq.${session.metadata.billingBatchId}&status=eq.payment_link_sent`, {
          method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'failed' }),
        });
        await supabaseRequest(`/bookings?billing_batch_id=eq.${session.metadata.billingBatchId}&payment_status=eq.invoiced`, {
          method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ payment_status: 'failed' }),
        });
        console.warn(`⌛ Batch checkout session expired unpaid: batch ${session.metadata.billingBatchId}`);
        break;
      }
      if (session.metadata && session.metadata.bookingId) {
        // SCRUM-59: this used to filter on status=eq.scheduled, a status
        // value nothing has set since bookings started going straight to
        // 'confirmed' on creation — the ad-hoc single-booking Checkout Link
        // this handles (api/lifecycle.js charge-student) sets
        // payment_status: 'invoiced' instead, so guard on that (also
        // avoids clobbering a booking that settled through another path
        // in the meantime).
        await supabaseRequest(`/bookings?id=eq.${session.metadata.bookingId}&payment_status=eq.invoiced`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ status: 'payment_failed', payment_status: 'failed' }),
        });
        console.warn(`⌛ Checkout session expired unpaid: booking ${session.metadata.bookingId}`);
      }
      break;
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object;
      const failureMessage = pi.last_payment_error?.message || 'Unknown error';
      logError('webhook.stripe.payment_intent.payment_failed', new Error(`${pi.id}: ${failureMessage}`));
      await alertCritical(
        'Payment failed',
        `PaymentIntent ${pi.id} failed for booking ${pi.metadata?.bookingId || '(none)'} batch ${pi.metadata?.billingBatchId || '(none)'}: ${failureMessage}`
      );
      if (pi.metadata && pi.metadata.billingBatchId) {
        await supabaseRequest(`/billing_batches?id=eq.${pi.metadata.billingBatchId}`, {
          method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'failed' }),
        });
        await supabaseRequest(`/bookings?billing_batch_id=eq.${pi.metadata.billingBatchId}`, {
          method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ payment_status: 'failed' }),
        });
        break;
      }
      if (pi.metadata && pi.metadata.bookingId) {
        await supabaseRequest(`/bookings?id=eq.${pi.metadata.bookingId}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ status: 'payment_failed', payment_status: 'failed' }),
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

// Marks every booking in a periodic-billing batch as paid, and the batch
// itself, once its Stripe payment_intent/checkout session completes.
// Idempotent against Stripe's at-least-once webhook delivery: re-running
// this on a redelivered event just re-sets the same rows to 'paid'.
async function markBillingBatchPaid(billingBatchId, paymentIntentId) {
  await supabaseRequest(`/billing_batches?id=eq.${billingBatchId}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({
      status: 'paid', paid_at: new Date().toISOString(),
      stripe_payment_intent_id: paymentIntentId, payment_link: null,
    }),
  });
  await supabaseRequest(`/bookings?billing_batch_id=eq.${billingBatchId}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ payment_status: 'paid' }),
  });
  console.log(`✅ Billing batch paid: ${billingBatchId}`);
}

// ── Calendly ─────────────────────────────────────────────────────────────
// invitee.created creates the bookings row, confirmed immediately
// regardless of lesson type — payment for paid lesson types is no longer
// collected here. It's billed periodically per the family's own
// billing_cycle (see api/billing.js resource=billing-cron), the same as
// every other booking-creation path on the platform. Free trials are
// simply marked payment_status='free' since there's nothing to bill.
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
    logError('webhook.calendly.signature', err);
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
    logError('webhook.calendly.dedup', err);
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
    logError('webhook.calendly.handling', err);
    await alertCritical('Calendly webhook processing failed', `event=${event} dedupKey=${dedupKey}: ${err.message}`);
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

  // SCRUM-67: every tutor now shares the same single Calendly event type
  // (the account's free plan only allows one active event type at all), so
  // the booked event type URI can no longer disambiguate which tutor was
  // booked — the lead's own assigned_tutor is the only reliable source of
  // truth here (set when the lead was assigned, before the scheduling link
  // was ever sent).
  const tutorName = lead.assigned_tutor;
  if (!tutorName) {
    console.warn(`Calendly invitee.created: lead ${lead.id} has no assigned tutor`);
    return;
  }

  const durationMins = Math.round((new Date(parsed.endTime) - new Date(parsed.startTime)) / 60000) || 55;
  const lessonType = lead.notes && /trial/i.test(lead.notes) ? 'trial' : (lead.level === 'alevel' ? 'alevel' : 'gcse');
  const pricing = resolvePrice(lessonType, lead.level);
  const meetingLink = await getMeetingLink(tutorName);

  const leadEmail = normalizeEmail(lead.email);
  const existingStudents = await dbGet(`/students?parent_email=eq.${encodeURIComponent(leadEmail)}&limit=1`);
  const student = existingStudents.length
    ? existingStudents[0]
    : await dbPost('/students', { parent_name: lead.name, parent_email: leadEmail, student_name: lead.name });

  const isFree = pricing.amount === 0;
  await dbPost('/bookings', {
    student_id: student.id,
    tutor_name: tutorName,
    subject: lead.subject,
    lesson_type: lessonType,
    start_time: parsed.startTime,
    duration_mins: durationMins,
    fee_pence: pricing.amount,
    status: 'confirmed',
    payment_status: isFree ? 'free' : 'unbilled',
    meet_link: meetingLink,
    calendly_event_uri: parsed.eventUri,
    calendly_invitee_uri: parsed.inviteeUri,
  });

  await supabaseRequest(`/leads?id=eq.${lead.id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ status: 'confirmed' }),
  });

  const { sendBookingConfirmation } = require('../lib/reminders');
  await sendBookingConfirmation({
    studentName: lead.name, parentName: lead.name, parentEmail: lead.email,
    tutorName, subject: lead.subject, lessonType, studentLevel: lead.level,
    startTime: parsed.startTime, durationMins, meetingLink, amountPence: pricing.amount,
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
