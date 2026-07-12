// api/webhook.js
// POST /api/webhook
// Receives Stripe events (payment succeeded/failed, card saved).
// Vercel note: webhooks need the RAW body for signature verification,
// so we disable body parsing for this route via the config export below.

const getRawBody = require('raw-body');

// Tell Vercel NOT to parse the body — Stripe needs it raw to verify the signature
module.exports.config = {
  api: { bodyParser: false },
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(500).json({ error: 'Stripe webhook not configured' });
  }
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

  let event;
  try {
    const rawBody = await getRawBody(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
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
      // Student paid via payment link
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
      }
      break;
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object;
      console.error(`❌ Payment failed: ${pi.id} — ${pi.last_payment_error?.message}`);
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
