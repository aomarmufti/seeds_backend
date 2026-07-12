// api/create-payment-intent.js
// POST /api/create-payment-intent
// Charges a saved card for a specific lesson.
// Pricing: GCSE £40, A-Level £45, Group £20, Trial £0.

const { applyCors } = require('../lib/cors');
const { resolvePrice } = require('../lib/pricing');

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Stripe is not configured (STRIPE_SECRET_KEY missing)' });
  }
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

  try {
    const {
      customerId, paymentMethodId,
      lessonType, studentLevel,
      studentName, tutorName, subject, lessonDate, parentEmail,
    } = req.body || {};

    const pricing = resolvePrice(lessonType, studentLevel);

    // Free trial — no charge
    if (pricing.amount === 0) {
      return res.status(200).json({ status: 'free', amount: 0 });
    }

    // Deterministic per logical charge attempt, so a client retry (network
    // blip, double-click) reuses the same PaymentIntent instead of charging twice.
    const idempotencyKey = `charge:${customerId}:${paymentMethodId}:${tutorName}:${subject}:${lessonDate}:${lessonType}`;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: pricing.amount,
      currency: pricing.currency,
      customer: customerId,
      payment_method: paymentMethodId,
      confirm: true,
      off_session: true,
      description: `${pricing.label} — ${studentName} — ${tutorName}`,
      receipt_email: parentEmail,
      metadata: {
        lessonType, studentLevel: studentLevel || '',
        studentName: studentName || '', tutorName: tutorName || '',
        subject: subject || '', lessonDate: lessonDate || '',
      },
    }, { idempotencyKey });

    res.status(200).json({
      status: paymentIntent.status,
      paymentIntentId: paymentIntent.id,
      amount: pricing.amount,
      amountDisplay: `£${(pricing.amount / 100).toFixed(2)}`,
    });
  } catch (err) {
    if (err.type === 'StripeCardError') {
      return res.status(402).json({ error: 'card_declined', message: err.message, code: err.code });
    }
    console.error('Payment intent error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
