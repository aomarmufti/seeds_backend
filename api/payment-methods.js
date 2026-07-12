// api/payment-methods.js
// GET  /api/payment-methods?customerId=cus_xxx        — list saved cards
// POST /api/payment-methods { action: 'detach', paymentMethodId }

const { applyCors } = require('../lib/cors');
const { getPaymentService } = require('../lib/payments');

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  let payments;
  try {
    payments = getPaymentService();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  if (req.method === 'GET') {
    const { customerId } = req.query;
    if (!customerId) return res.status(400).json({ error: 'customerId required' });
    try {
      const methods = await payments.listPaymentMethods(customerId);
      return res.status(200).json(methods.map(m => ({
        id: m.id,
        brand: m.card?.brand,
        last4: m.card?.last4,
        expMonth: m.card?.exp_month,
        expYear: m.card?.exp_year,
      })));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    const { action, paymentMethodId } = req.body || {};
    if (action !== 'detach') return res.status(400).json({ error: 'Unknown action' });
    if (!paymentMethodId) return res.status(400).json({ error: 'paymentMethodId required' });
    try {
      await payments.detachPaymentMethod(paymentMethodId);
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};
