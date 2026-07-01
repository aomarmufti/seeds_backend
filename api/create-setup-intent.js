// api/create-setup-intent.js
// POST /api/create-setup-intent
// Creates a Stripe Customer + SetupIntent so a card can be saved on file
// and charged automatically per lesson (direct-debit-style billing).

const { applyCors } = require('../lib/cors');

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Initialise Stripe inside the handler — if the key is missing,
  // this endpoint fails cleanly instead of crashing the whole server.
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Stripe is not configured (STRIPE_SECRET_KEY missing)' });
  }
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

  try {
    const { parentName, parentEmail, parentPhone } = req.body || {};

    if (!parentEmail) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Get or create the customer (avoid duplicates by email)
    const existing = await stripe.customers.list({ email: parentEmail, limit: 1 });
    const customer = existing.data.length > 0
      ? existing.data[0]
      : await stripe.customers.create({ email: parentEmail, name: parentName, phone: parentPhone });

    const setupIntent = await stripe.setupIntents.create({
      customer: customer.id,
      payment_method_types: ['card'],
      usage: 'off_session', // allows charging later without the customer present
      metadata: { parentName: parentName || '', parentEmail, parentPhone: parentPhone || '' },
    });

    res.status(200).json({
      clientSecret: setupIntent.client_secret,
      customerId: customer.id,
    });
  } catch (err) {
    console.error('Setup intent error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
