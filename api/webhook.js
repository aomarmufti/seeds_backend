// api/webhook.js
// POST /api/webhook
// Receives Stripe events (payment succeeded/failed, card saved).
// Vercel note: webhooks need the RAW body for signature verification,
// so we disable body parsing for this route via the config export below.

const getRawBody = require('raw-body');
const { getPaymentService } = require('../lib/payments');

// Tell Vercel NOT to parse the body — Stripe needs it raw to verify the signature
module.exports.config = {
  api: { bodyParser: false },
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let payments;
  try {
    payments = getPaymentService();
  } catch (err) {
    return res.status(500).json({ error: 'Stripe webhook not configured' });
  }

  let event;
  try {
    const rawBody = await getRawBody(req);
    const sig = req.headers['stripe-signature'];
    event = payments.constructWebhookEvent(rawBody, sig);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const { supabaseRequest } = require('../lib/db');

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
    console.error('Webhook dedup check failed:', err.message);
    return res.status(500).json({ error: 'Webhook dedup check failed' });
  }

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      console.log(`✅ Payment succeeded: ${pi.id} — £${pi.amount / 100}`);
      // Update booking if linked via metadata
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
        const { dbGet } = require('../lib/db');
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
};
