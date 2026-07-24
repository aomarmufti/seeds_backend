// api/billing.js
// GET  /api/billing?resource=payment-methods&customerId=cus_xxx  — list saved cards
// POST /api/billing { resource: 'payment-methods', action: 'detach', paymentMethodId }
// POST /api/billing { resource: 'customer-portal', customerId, returnUrl }
//
// Parent-facing self-service billing endpoints, combined into one file
// (Vercel's Hobby plan caps a deployment at 12 serverless functions and
// this repo is at that limit — grouping related small endpoints avoids
// adding a function per tiny piece of functionality).

const { applyCors } = require('../lib/cors');
const { getPaymentService } = require('../lib/payments');
const { requireAuth } = require('../lib/auth');
const { dbGet, dbPost, dbPatch } = require('../lib/db');

// Confirms the authenticated caller owns this Stripe customer id (their own
// students.stripe_customer_id), unless they're an admin. Returns true/false;
// callers are responsible for responding with 403 on false.
async function callerOwnsCustomer(caller, customerId) {
  if (caller.role === 'admin') return true;
  if (!customerId) return false;
  const students = await dbGet(
    `/students?parent_email=eq.${encodeURIComponent(caller.email)}&stripe_customer_id=eq.${encodeURIComponent(customerId)}&limit=1`
  );
  return students.length > 0;
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  const caller = await requireAuth(req, res);
  if (!caller) return;

  let payments;
  try {
    payments = getPaymentService();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  if (req.method === 'GET' && req.query.resource === 'payment-methods') {
    const { customerId } = req.query;
    if (!customerId) return res.status(400).json({ error: 'customerId required' });
    if (!(await callerOwnsCustomer(caller, customerId))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
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
    const { resource } = req.body || {};

    if (resource === 'payment-methods') {
      const { action, paymentMethodId, customerId } = req.body;
      if (action !== 'detach') return res.status(400).json({ error: 'Unknown action' });
      if (!paymentMethodId || !customerId) return res.status(400).json({ error: 'paymentMethodId and customerId required' });
      if (!(await callerOwnsCustomer(caller, customerId))) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      try {
        // Confirm the payment method actually belongs to the customer the
        // caller was verified to own, not just any paymentMethodId they pass.
        const methods = await payments.listPaymentMethods(customerId);
        if (!methods.some(m => m.id === paymentMethodId)) {
          return res.status(403).json({ error: 'Forbidden' });
        }
        await payments.detachPaymentMethod(paymentMethodId);
        return res.status(200).json({ success: true });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // Lets a logged-in student/parent add a card independently of booking a
    // lesson — previously the ONLY way to end up with a saved card was via
    // the public wizard's paid-lesson flow, and even then the resulting
    // Stripe customer id was never written back onto the student's row, so
    // "saved cards" could never actually be listed for anyone afterwards.
    // Idempotent: reuses the existing Stripe customer if this student
    // already has one, rather than creating a duplicate on every click.
    if (resource === 'setup-intent') {
      try {
        const existing = await dbGet(`/students?parent_email=eq.${encodeURIComponent(caller.email)}&limit=1`);
        let student = existing[0];
        if (!student) {
          student = await dbPost('/students', {
            parent_name: caller.email, parent_email: caller.email, student_name: caller.email,
          });
        }
        let customerId = student.stripe_customer_id;
        if (!customerId) {
          const customer = await payments.createCustomer({ email: caller.email, name: student.parent_name || caller.email });
          customerId = customer.id;
          await dbPatch(`/students?id=eq.${student.id}`, { stripe_customer_id: customerId });
        }
        const setupIntent = await payments.createSetupIntent({ customerId, metadata: { parentEmail: caller.email } });
        return res.status(200).json({ clientSecret: setupIntent.client_secret, customerId });
      } catch (err) {
        console.error('Setup intent error:', err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    if (resource === 'customer-portal') {
      // Requires the Customer Portal to be configured once in the Stripe
      // Dashboard (Settings -> Billing -> Customer portal) — which
      // features are enabled, business branding, etc. That's a one-time
      // manual setup step in the Stripe account, not something this
      // endpoint can do.
      const { customerId, returnUrl } = req.body;
      if (!customerId) return res.status(400).json({ error: 'customerId required' });
      if (!(await callerOwnsCustomer(caller, customerId))) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      try {
        const session = await payments.createCustomerPortalSession({
          customerId,
          returnUrl: returnUrl || process.env.FRONTEND_URL || 'https://seedsinstitute.co.uk',
        });
        return res.status(200).json({ url: session.url });
      } catch (err) {
        console.error('Customer portal error:', err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    return res.status(400).json({ error: 'Unknown resource' });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
