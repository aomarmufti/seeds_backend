// api/payouts.js — payouts + Stripe Connect for real tutor payments
const { applyCors } = require('../lib/cors');
const { dbGet, dbPost, supabaseRequest } = require('../lib/db');
const { requireAdmin, requireAuth } = require('../lib/auth');
const { logAdminAction } = require('../lib/auditLog');
const { logError, alertCritical } = require('../lib/logger');

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

// Real earnings/payout data and, further down, the ability to point a
// tutor's future payouts at an arbitrary Stripe account — previously
// reachable by anyone with zero authentication at all.
async function verifyTutorIdentity(caller, tutorName) {
  if (caller.role === 'admin') return true;
  const profiles = await dbGet(`/profiles?id=eq.${caller.id}&select=tutor_name&limit=1`);
  return profiles[0]?.tutor_name === tutorName;
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  if (req.method === 'GET') {
    const caller = await requireAuth(req, res);
    if (!caller) return;
    const { tutor, resource } = req.query;

    if (resource === 'verify' && tutor) {
      if (!(await verifyTutorIdentity(caller, tutor))) return res.status(403).json({ error: 'Forbidden' });
      try {
        // Includes payment_failed alongside confirmed/completed so a tutor
        // can see a lesson's payment status read-only even before the
        // student has paid — payout eligibility itself is still computed
        // elsewhere (api/analytics.js) from confirmed/completed only, this
        // is just visibility. ('scheduled' dropped from this filter —
        // SCRUM-59: no booking has had that status since creation started
        // going straight to 'confirmed'.)
        const bookings = await dbGet(
          `/bookings?tutor_name=eq.${encodeURIComponent(tutor)}&fee_pence=gt.0&status=in.(payment_failed,confirmed,completed)&select=id,subject,lesson_type,start_time,fee_pence,status,payment_status,stripe_payment_intent_id,students(student_name)&order=start_time.desc`
        );
        return res.status(200).json(bookings);
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    if (resource === 'connect-status' && tutor) {
      if (!(await verifyTutorIdentity(caller, tutor))) return res.status(403).json({ error: 'Forbidden' });
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
          return res.status(200).json({ connected: true, onboardingComplete: complete, accountId: acct.stripe_account_id, payoutCycle: acct.payout_cycle || 'weekly' });
        }
        return res.status(200).json({ connected: true, onboardingComplete: acct.onboarding_complete, accountId: acct.stripe_account_id, payoutCycle: acct.payout_cycle || 'weekly' });
      } catch(e) {
        // If table doesn't exist yet, return not-connected rather than crashing
        if (e.message && (e.message.includes('tutor_accounts') || e.message.includes('schema cache') || e.message.includes('42P01'))) {
          return res.status(200).json({ connected: false, onboardingComplete: false, setupRequired: true });
        }
        return res.status(500).json({ error: e.message });
      }
    }

    if (tutor) {
      if (!(await verifyTutorIdentity(caller, tutor))) return res.status(403).json({ error: 'Forbidden' });
    } else if (caller.role !== 'admin') {
      // No tutor filter means "list every payout" — admin-only.
      return res.status(403).json({ error: 'Forbidden' });
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
      if (!tutorName) return res.status(400).json({ error: 'tutorName required' });
      const caller = await requireAuth(req, res);
      if (!caller) return;
      // Points a tutor's future payouts at a Stripe account — must only ever
      // be that tutor themselves (or an admin), never an arbitrary caller.
      if (!(await verifyTutorIdentity(caller, tutorName))) return res.status(403).json({ error: 'Forbidden' });
      const stripe = getStripe();
      if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
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
        const origin = body.returnOrigin || process.env.FRONTEND_URL || 'https://seedsinstitute.co.uk';
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
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      await logAdminAction({
        actor: admin.email, action: 'approve-and-transfer',
        targetType: 'tutor', targetId: tutorName,
        details: { amountPence: body.amountPence },
      });
      const stripe = getStripe();
      try {
        // Only mark a booking "tutor paid out" if (a) the student has
        // actually paid for it (payment_status='paid') — under periodic
        // billing a booking is confirmed the moment it's made regardless of
        // billing status, so status=confirmed alone (the old check) would
        // let an admin pay a tutor out for lessons never actually charged —
        // and (b) somebody attested to the outcome. delivery_status replaces
        // the old end_time<=now() proxy: a past end_time never meant the
        // lesson ran. The billable outcomes are the payable ones, including
        // 'late_cancelled' (status='cancelled', but the tutor held the slot,
        // so having billed the family we owe them the fee).
        //
        // paid_out_at, not status='completed', is now the paid-out marker —
        // see 20260728170500_separate_payout_marker_from_status.sql. It also
        // makes this PATCH idempotent: an already-paid booking has a
        // non-null paid_out_at and drops out of the filter.
        await supabaseRequest(
          `/bookings?tutor_name=eq.${encodeURIComponent(tutorName)}&delivery_status=in.(delivered,no_show,late_cancelled)&payment_status=eq.paid&fee_pence=gt.0&paid_out_at=is.null`,
          { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ paid_out_at: new Date().toISOString() }) }
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
      } catch(e) {
        logError('payouts.approve-and-transfer', e);
        await alertCritical('Tutor payout transfer failed', `tutor=${tutorName} amountPence=${body.amountPence}: ${e.message}`);
        return res.status(500).json({ error: e.message });
      }
    }

    // SCRUM-76: payouts are automatic (weekly or monthly, whichever the
    // admin sets per tutor — see api/lifecycle?resource=auto-payout), so
    // there's no more tutor-facing "request a payout" action here. This is
    // the admin control for which cycle a tutor is on.
    if (action === 'set-payout-cycle') {
      if (!tutorName || !['weekly', 'monthly'].includes(body.payoutCycle)) {
        return res.status(400).json({ error: 'tutorName and a payoutCycle of weekly or monthly are required' });
      }
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      try {
        const r = await supabaseRequest('/tutor_accounts?on_conflict=tutor_name', {
          method: 'POST',
          prefer: 'resolution=merge-duplicates,return=minimal',
          body: JSON.stringify({ tutor_name: tutorName, payout_cycle: body.payoutCycle }),
        });
        if (!r.ok) { const d = await r.json(); throw new Error(JSON.stringify(d)); }
        return res.status(200).json({ success: true });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
