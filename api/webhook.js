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

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      console.log(`✅ Payment succeeded: ${pi.id} — £${pi.amount / 100}`);
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
