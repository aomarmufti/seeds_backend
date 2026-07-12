// api/create-setup-intent.js
// POST /api/create-setup-intent
// Creates a Stripe Customer + SetupIntent so a card can be saved on file
// and charged automatically per lesson (direct-debit-style billing).

const { applyCors } = require('../lib/cors');
const { getPaymentService } = require('../lib/payments');

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let payments;
  try {
    payments = getPaymentService();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  try {
    const { parentName, parentEmail, parentPhone } = req.body || {};

    if (!parentEmail) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const customer = await payments.createCustomer({ email: parentEmail, name: parentName, phone: parentPhone });

    const setupIntent = await payments.createSetupIntent({
      customerId: customer.id,
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
