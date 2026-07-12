// api/customer-portal.js
// POST /api/customer-portal { customerId, returnUrl }
// Creates a Stripe Customer Portal session so parents can manage saved
// cards and view/download invoices without a custom UI for all of it.
//
// Requires the Customer Portal to be configured once in the Stripe
// Dashboard (Settings -> Billing -> Customer portal) — which features
// are enabled, business branding, etc. That's a one-time manual setup
// step in the Stripe account, not something this endpoint can do.

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
    const { customerId, returnUrl } = req.body || {};
    if (!customerId) return res.status(400).json({ error: 'customerId required' });
    const session = await payments.createCustomerPortalSession({
      customerId,
      returnUrl: returnUrl || process.env.FRONTEND_URL || 'https://seedsinstitute.co.uk',
    });
    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Customer portal error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
