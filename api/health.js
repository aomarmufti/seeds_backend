// api/health.js — full system diagnostics
// Visit https://seeds-backend-six.vercel.app/api/health for a complete status report
const { applyCors } = require('../lib/cors');
const { dbGet } = require('../lib/db');
const { requireAdmin } = require('../lib/auth');

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  if (!(await requireAdmin(req, res))) return;

  const report = { time: new Date().toISOString(), env: {}, database: {}, stripe: {}, email: {} };

  // 1. Environment variables
  const envVars = ['SUPABASE_URL','SUPABASE_SERVICE_KEY','STRIPE_SECRET_KEY',
                   'STRIPE_PUBLISHABLE_KEY','RESEND_API_KEY','EMAIL_FROM',
                   'MEET_LINK_AZEEM','MEET_LINK_SULEIMAN','MEET_LINK_ABDULMOEZ'];
  envVars.forEach(v => report.env[v] = process.env[v] ? '✓ set' : '✗ MISSING');

  // 2. Database tables
  const tables = ['students','bookings','payouts','leads','profiles',
                  'lesson_notes','homework','progress','messages','tutor_accounts'];
  for (const t of tables) {
    try {
      await dbGet(`/${t}?limit=1`);
      report.database[t] = '✓ ok';
    } catch (e) {
      report.database[t] = `✗ ${e.message.slice(0, 80)}`;
    }
  }

  // 3. Stripe + Connect
  if (process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      const acct = await stripe.accounts.retrieve();
      report.stripe.key = '✓ valid';
      report.stripe.mode = process.env.STRIPE_SECRET_KEY.startsWith('sk_test') ? 'test' : 'LIVE';
      report.stripe.account = acct.id;
      try {
        await stripe.accounts.list({ limit: 1 });
        report.stripe.connect = '✓ enabled';
      } catch (e) {
        report.stripe.connect = '✗ NOT ENABLED — go to Stripe Dashboard → Connect → Get started, choose Express accounts';
      }
    } catch (e) {
      report.stripe.key = `✗ invalid: ${e.message.slice(0, 80)}`;
    }
  } else {
    report.stripe.key = '✗ STRIPE_SECRET_KEY missing';
  }

  // 4. Email note
  report.email.note = process.env.EMAIL_FROM === 'onboarding@resend.dev'
    ? '⚠ Using onboarding@resend.dev — Resend TEST mode can ONLY send to the email address that owns the Resend account. To email real students/parents, verify a domain in Resend and change EMAIL_FROM.'
    : `✓ sending from ${process.env.EMAIL_FROM}`;

  // 5. RLS status note — this check always used the service key, which bypasses
  // RLS by design, so it could never actually detect a misconfiguration. Removed
  // the misleading self-check; verify RLS via Supabase Dashboard → Advisors instead.
  report.security = { rls: 'Not checked here — this endpoint uses the service key, which bypasses RLS. Verify via Supabase Dashboard → Advisors.' };

  const problems = [
    ...Object.values(report.env), ...Object.values(report.database),
    ...Object.values(report.stripe),
  ].filter(v => String(v).startsWith('✗'));
  report.summary = problems.length ? `${problems.length} problem(s) found — see ✗ items` : '✓ All systems operational';

  res.status(200).json(report);
};
