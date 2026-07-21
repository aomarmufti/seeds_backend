// api/payouts.js — payouts + Stripe Connect for real tutor payments
const { applyCors } = require('../lib/cors');
const { dbGet, dbPost, supabaseRequest } = require('../lib/db');
const { requireAdmin } = require('../lib/auth');

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

async function getTutorAccount(tutorName) {
  try {
    const rows = await dbGet(`/tutor_accounts?tutor_name=eq.${encodeURIComponent(tutorName)}&limit=1`);
    return rows.length ? rows[0] : null;
  } catch(e) {
    // Table doesn't exist yet — return null so callers can handle gracefully
    return null;
  }
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  if (req.method === 'GET') {
    const { tutor, resource } = req.query;

    if (resource === 'verify' && tutor) {
      try {
        const bookings = await dbGet(
          `/bookings?tutor_name=eq.${encodeURIComponent(tutor)}&fee_pence=gt.0&status=in.(confirmed,completed)&select=id,subject,lesson_type,start_time,fee_pence,status,students(student_name)&order=start_time.desc`
        );
        return res.status(200).json(bookings);
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    if (resource === 'connect-status' && tutor) {
      try {
        const acct = await getTutorAccount(tutor);
        if (!acct || !acct.stripe_account_id) {
          return res.status(200).json({ connected: false, onboardingComplete: false });
        }
        const stripe = getStripe();
        if (stripe) {
          const sa = await stripe.accounts.retrieve(acct.stripe_account_id);
          const complete = sa.details_submitted && sa.payouts_enabled;
          if (complete !== acct.onboarding_complete) {
            await supabaseRequest(`/tutor_accounts?tutor_name=eq.${encodeURIComponent(tutor)}`, {
              method: 'PATCH', prefer: 'return=minimal',
              body: JSON.stringify({
                onboarding_complete: complete,
                charges_enabled: sa.charges_enabled,
                payouts_enabled: sa.payouts_enabled,
              }),
            });
          }
          return res.status(200).json({ connected: true, onboardingComplete: complete, accountId: acct.stripe_account_id });
        }
        return res.status(200).json({ connected: true, onboardingComplete: acct.onboarding_complete, accountId: acct.stripe_account_id });
      } catch(e) {
        // If table doesn't exist yet, return not-connected rather than crashing
        if (e.message && (e.message.includes('tutor_accounts') || e.message.includes('schema cache') || e.message.includes('42P01'))) {
          return res.status(200).json({ connected: false, onboardingComplete: false, setupRequired: true });
        }
        return res.status(500).json({ error: e.message });
      }
    }

    let path = '/payouts?order=requested_at.desc';
    if (tutor) path += `&tutor_name=eq.${encodeURIComponent(tutor)}`;
    try {
      return res.status(200).json(await dbGet(path));
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const { action, tutorName } = body;

    if (action === 'create-connect-account') {
      const stripe = getStripe();
      if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
      if (!tutorName) return res.status(400).json({ error: 'tutorName required' });
      try {
        let acct = await getTutorAccount(tutorName);
        let accountId = acct && acct.stripe_account_id;
        if (!accountId) {
          const account = await stripe.accounts.create({
            type: 'express', country: 'GB',
            email: body.tutorEmail || undefined,
            business_type: 'individual',
            capabilities: { transfers: { requested: true } },
            business_profile: { product_description: 'Online tuition services via Seeds' },
            metadata: { tutorName },
          });
          accountId = account.id;
          if (acct) {
            await supabaseRequest(`/tutor_accounts?tutor_name=eq.${encodeURIComponent(tutorName)}`, {
              method: 'PATCH', prefer: 'return=minimal',
              body: JSON.stringify({ stripe_account_id: accountId, tutor_email: body.tutorEmail || null }),
            });
          } else {
            await dbPost('/tutor_accounts', {
              tutor_name: tutorName, tutor_email: body.tutorEmail || null, stripe_account_id: accountId,
            });
          }
        }
        const origin = body.returnOrigin || 'http://localhost:8080';
        const link = await stripe.accountLinks.create({
          account: accountId,
          refresh_url: `${origin}/seeds-full-platform.html?connect=refresh`,
          return_url: `${origin}/seeds-full-platform.html?connect=done`,
          type: 'account_onboarding',
        });
        return res.status(200).json({ success: true, url: link.url, accountId });
      } catch(e) {
        const msg = /Connect|signed up|platform/i.test(e.message)
          ? 'Stripe Connect is not enabled on your Stripe account yet. Admin: go to Stripe Dashboard → Connect → Get started → choose Express accounts. Then try again.'
          : e.message;
        return res.status(500).json({ error: msg });
      }
    }

    if (action === 'approve-and-transfer' || body.markPaid) {
      // The only caller is the admin panel's "Approve & mark paid" — this
      // moves real money via Stripe transfer.
      if (!(await requireAdmin(req, res))) return;
      const stripe = getStripe();
      try {
        await supabaseRequest(
          `/bookings?tutor_name=eq.${encodeURIComponent(tutorName)}&status=eq.confirmed&fee_pence=gt.0`,
          { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'completed' }) }
        );
        let transferId = null, transferStatus = 'manual';
        const acct = await getTutorAccount(tutorName);
        if (stripe && acct && acct.stripe_account_id && acct.onboarding_complete && body.amountPence >= 5000) {
          const payoutDay = new Date().toISOString().slice(0,10);
          const transfer = await stripe.transfers.create({
            amount: body.amountPence, currency: 'gbp',
            destination: acct.stripe_account_id,
            description: `Seeds payout — ${tutorName}`,
            metadata: { tutorName },
          }, { idempotencyKey: `manual-payout:${tutorName}:${body.amountPence}:${payoutDay}` });
          transferId = transfer.id; transferStatus = 'paid';

          // Notify tutor their payment has landed
          try {
            const { sendPayoutNotification } = require('../lib/reminders');
            const profiles = await dbGet(`/profiles?tutor_name=eq.${encodeURIComponent(tutorName)}&limit=1`);
            const tutorEmail = profiles[0]?.email;
            if (tutorEmail) {
              await sendPayoutNotification({
                tutorEmail, tutorName, amountPence: body.amountPence,
                transferId, isAutomatic: !!body._auto,
              });
            }
          } catch(emailErr) { console.warn('Payout email failed:', emailErr.message); }
        }
        await supabaseRequest(
          `/payouts?tutor_name=eq.${encodeURIComponent(tutorName)}&status=eq.requested`,
          { method: 'PATCH', prefer: 'return=minimal',
            body: JSON.stringify({ status: 'paid', paid_at: new Date().toISOString(), stripe_transfer_id: transferId, transfer_status: transferStatus }) }
        );
        return res.status(200).json({ success: true, transferId, transferStatus });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    if (!tutorName || !body.amountPence || body.amountPence < 5000) {
      return res.status(400).json({ error: 'Minimum payout £50' });
    }
    try {
      const payout = await dbPost('/payouts', { tutor_name: tutorName, amount_pence: body.amountPence, status: 'requested' });
      return res.status(201).json({ success: true, payout });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  res.status(405).json({ error: 'Method not allowed' });
};
