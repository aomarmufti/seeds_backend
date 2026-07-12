// api/calendly-webhook.js
// POST /api/calendly-webhook
// Receives Calendly's invitee.created / invitee.canceled events, which
// drive the "Calendly Booking" step of the booking flow:
//   Requested -> Tutor Assigned -> Calendly Booking -> Stripe Checkout ->
//   Payment Successful -> Booking Confirmed
//
// invitee.created: creates the bookings row (status='scheduled') and, for
// paid lesson types, a Stripe Checkout session + payment-link email. Free
// trials skip straight to 'confirmed' since there's nothing to pay.
// invitee.canceled: cancels the linked booking.

const { dbGet, dbPost, supabaseRequest } = require('../lib/db');
const { resolvePrice } = require('../lib/pricing');
const { getPaymentService } = require('../lib/payments');
const { verifyWebhookSignature, parseInviteeCreatedPayload } = require('../lib/calendly');

function getMeetingLink(tutorName) {
  const links = {
    'Azeem': process.env.MEET_LINK_AZEEM,
    'Azeem Omar-Mufti': process.env.MEET_LINK_AZEEM,
    'Suleiman': process.env.MEET_LINK_SULEIMAN,
    'Abdul-Moez': process.env.MEET_LINK_ABDULMOEZ,
  };
  return links[tutorName] || 'https://meet.google.com/seeds-tuition';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.CALENDLY_WEBHOOK_SIGNING_KEY) {
    return res.status(500).json({ error: 'Calendly webhook not configured' });
  }

  const rawBody = JSON.stringify(req.body || {});
  try {
    verifyWebhookSignature(rawBody, req.headers['calendly-webhook-signature'], process.env.CALENDLY_WEBHOOK_SIGNING_KEY);
  } catch (err) {
    console.error('Calendly webhook signature failed:', err.message);
    return res.status(400).json({ error: err.message });
  }

  const { event, payload } = req.body || {};
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
};

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

  const profiles = await dbGet(`/profiles?calendly_event_type_uri=eq.${encodeURIComponent(parsed.eventTypeUri)}&limit=1`);
  const tutorName = profiles[0]?.tutor_name || lead.assigned_tutor;
  if (!tutorName) {
    console.warn(`Calendly invitee.created: no tutor resolved for event type ${parsed.eventTypeUri}`);
    return;
  }

  const durationMins = Math.round((new Date(parsed.endTime) - new Date(parsed.startTime)) / 60000) || 55;
  const lessonType = lead.notes && /trial/i.test(lead.notes) ? 'trial' : (lead.level === 'alevel' ? 'alevel' : 'gcse');
  const pricing = resolvePrice(lessonType, lead.level);
  const meetingLink = getMeetingLink(tutorName);

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
