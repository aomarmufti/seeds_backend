// api/webhook.js
// POST /api/webhook
// Single webhook receiver for both Stripe and Cal.com, dispatched by
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
const { verifyWebhookSignature: verifyCalSignature, parseBookingPayload } = require('../lib/cal');
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
  if (req.headers['x-cal-signature-256']) {
    return handleCalWebhook(req, res, rawBody);
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

// ── Cal.com ──────────────────────────────────────────────────────────────
// BOOKING_CREATED creates the bookings row for a family who booked their
// free Initial Consultation via a link emailed from api/leads.js's
// assign-tutor flow — the only thing that flow ever sends is
// cal_consultation_link, so the resulting booking is always
// lesson_type='consultation', matching how api/bookings.js's own
// action=confirm creates the same kind of booking for the public wizard's
// direct embedded-widget flow (SCRUM-58 split the free "Initial
// Consultation" out from the trial lesson booked separately afterward from
// the portal — this handler predates that split and was still inferring
// gcse/alevel/trial here under Calendly; fixed alongside this migration).
// BOOKING_CANCELLED cancels the linked booking.
//
// Not verified against a live Cal.com account/webhook in this
// environment — written to the documented v2 webhook payload shape.

async function handleCalWebhook(req, res, rawBody) {
  if (!process.env.CAL_WEBHOOK_SIGNING_SECRET) {
    return res.status(500).json({ error: 'Cal.com webhook not configured' });
  }

  try {
    verifyCalSignature(rawBody.toString('utf8'), req.headers['x-cal-signature-256'], process.env.CAL_WEBHOOK_SIGNING_SECRET);
  } catch (err) {
    logError('webhook.cal.signature', err);
    return res.status(400).json({ error: err.message });
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  const { triggerEvent, payload } = body || {};
  if (!payload) return res.status(400).json({ error: 'Missing payload' });

  // Idempotency: Cal.com bookings carry a single canonical `uid`, unlike
  // Calendly's separate event/invitee URIs — paired with the trigger event
  // name since a booking can be created, then later cancelled (two
  // distinct events sharing the same uid).
  const dedupKey = `${payload.uid || 'unknown'}:${triggerEvent}`;
  try {
    const dedupRes = await supabaseRequest('/cal_webhook_events', {
      method: 'POST',
      prefer: 'return=minimal',
      body: JSON.stringify({ event_id: dedupKey, event_type: triggerEvent }),
    });
    if (!dedupRes.ok) {
      if (dedupRes.status === 409) return res.status(200).json({ received: true, duplicate: true });
      const errBody = await dedupRes.json().catch(() => ({}));
      throw new Error(errBody.message || `Dedup insert failed with status ${dedupRes.status}`);
    }
  } catch (err) {
    logError('webhook.cal.dedup', err);
    return res.status(500).json({ error: 'Webhook dedup check failed' });
  }

  try {
    if (triggerEvent === 'BOOKING_CREATED') {
      await handleBookingCreated(payload);
    } else if (triggerEvent === 'BOOKING_CANCELLED') {
      await handleBookingCancelled(payload);
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    logError('webhook.cal.handling', err);
    await alertCritical('Cal.com webhook processing failed', `event=${triggerEvent} dedupKey=${dedupKey}: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
}

async function handleBookingCreated(payload) {
  const parsed = parseBookingPayload(payload);
  if (!parsed.trackingId) {
    // Booked directly through the public wizard, student portal, or tutor
    // "Add lesson" flow — those all create their own bookings row up front
    // (via api/bookings.js's action=confirm or api/lifecycle.js's
    // resource=lessons), so there's no lead to reconcile against here.
    // Still worth reconciling that existing row against THIS real Cal.com
    // booking though (SCRUM-77): it was created with a static
    // tutors.meet_link/MEET_LINK_* fallback, not the real per-event link
    // Cal.com just generated (e.g. via its own Google Calendar/Meet
    // integration) — without this, the family's calendar invite and our
    // own confirmation/reminder emails can point at two different rooms.
    await reconcileMeetingLink(parsed);
    return;
  }

  const leads = await dbGet(`/leads?id=eq.${parsed.trackingId}&limit=1`);
  const lead = leads[0];
  if (!lead) {
    console.warn(`Cal.com BOOKING_CREATED references unknown lead ${parsed.trackingId}`);
    return;
  }

  const tutorName = lead.assigned_tutor;
  if (!tutorName) {
    console.warn(`Cal.com BOOKING_CREATED: lead ${lead.id} has no assigned tutor`);
    return;
  }

  const pricing = resolvePrice('consultation', lead.level);
  const durationMins = Math.round((new Date(parsed.endTime) - new Date(parsed.startTime)) / 60000) || pricing.duration;
  // Prefer the real link Cal.com generated for this specific booking
  // (SCRUM-77) over the static tutors.meet_link/MEET_LINK_* fallback.
  const meetingLink = parsed.meetingLink || await getMeetingLink(tutorName);

  const leadEmail = normalizeEmail(lead.email);
  const existingStudents = await dbGet(`/students?parent_email=eq.${encodeURIComponent(leadEmail)}&limit=1`);
  const student = existingStudents.length
    ? existingStudents[0]
    : await dbPost('/students', { parent_name: lead.name, parent_email: leadEmail, student_name: lead.name });

  await dbPost('/bookings', {
    student_id: student.id,
    tutor_name: tutorName,
    subject: lead.subject,
    lesson_type: 'consultation',
    start_time: parsed.startTime,
    duration_mins: durationMins,
    fee_pence: 0,
    status: 'confirmed',
    payment_status: 'free',
    meet_link: meetingLink,
    cal_booking_uid: parsed.bookingUid,
  });

  await supabaseRequest(`/leads?id=eq.${lead.id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ status: 'confirmed' }),
  });

  const { sendBookingConfirmation } = require('../lib/reminders');
  await sendBookingConfirmation({
    studentName: lead.name, parentName: lead.name, parentEmail: lead.email,
    tutorName, subject: lead.subject, lessonType: 'consultation', studentLevel: lead.level,
    startTime: parsed.startTime, durationMins, meetingLink, amountPence: 0,
  });
}

// SCRUM-77: attaches this real Cal.com booking to whichever existing
// bookings row it corresponds to, for any flow that creates its own row up
// front rather than going through the lead/trackingId path above (public
// wizard, student portal, tutor "Add lesson"). Matched by tutor + exact
// start time rather than anything from the booking creation call itself,
// since none of those pass a bookingUid through at creation time — Cal.com
// is the only place that ever learns it. Best-effort: never blocks the
// webhook's 200 response, just logs and moves on if nothing matches.
async function reconcileMeetingLink(parsed) {
  if (!parsed.organizerEmail || !parsed.startTime) {
    console.warn('Cal.com BOOKING_CREATED with no tracking id and no organizer/startTime to reconcile against', parsed.bookingUid);
    return;
  }
  try {
    const tutors = await dbGet(`/tutors?email=eq.${encodeURIComponent(parsed.organizerEmail)}&select=name&limit=1`);
    const tutorName = tutors[0]?.name;
    if (!tutorName) {
      console.warn(`Cal.com BOOKING_CREATED: no tutor found for organizer ${parsed.organizerEmail}`);
      return;
    }
    const bookings = await dbGet(
      `/bookings?tutor_name=eq.${encodeURIComponent(tutorName)}&start_time=eq.${encodeURIComponent(parsed.startTime)}` +
      `&cal_booking_uid=is.null&status=neq.cancelled&limit=1`
    );
    const booking = bookings[0];
    if (!booking) {
      console.warn(`Cal.com BOOKING_CREATED: no matching booking for ${tutorName} at ${parsed.startTime}`);
      return;
    }
    const patch = { cal_booking_uid: parsed.bookingUid };
    if (parsed.meetingLink) patch.meet_link = parsed.meetingLink;
    await supabaseRequest(`/bookings?id=eq.${booking.id}`, {
      method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(patch),
    });
  } catch (err) {
    logError('webhook.cal.reconcileMeetingLink', err);
  }
}

async function handleBookingCancelled(payload) {
  const parsed = parseBookingPayload(payload);
  if (!parsed.bookingUid) return;
  await supabaseRequest(
    `/bookings?cal_booking_uid=eq.${encodeURIComponent(parsed.bookingUid)}&status=in.(scheduled,confirmed)`,
    { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'cancelled' }) }
  );
}
