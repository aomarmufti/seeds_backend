// lib/logger.js — structured error logging + critical-failure alerting
// (SCRUM-39).
//
// No external error-tracking service (Sentry, as the ticket suggested) is
// wired in here — that's an account/budget decision, not just code, and
// isn't something to provision unasked. What this does instead, using
// infrastructure that already exists:
//   - logError: every caught error becomes one structured JSON line
//     (queryable in Vercel's log viewer) instead of a bare, easy-to-miss
//     console.error/warn string.
//   - alertCritical: failure classes that actually cost money or silently
//     break a user-facing flow (payment failures, payout transfer
//     failures, webhook processing errors) email the admin instead of
//     only producing a log line nobody is watching.

function logError(context, error) {
  console.error(JSON.stringify({
    level: 'error',
    time: new Date().toISOString(),
    context,
    message: (error && error.message) || String(error),
    stack: error && error.stack,
  }));
}

// Best-effort — never throws, so a broken alert path can never mask or
// replace the caller's own error handling.
async function alertCritical(subject, details) {
  try {
    const { sendAdminAlert } = require('./reminders');
    await sendAdminAlert({
      subject,
      details: typeof details === 'string' ? details : JSON.stringify(details, null, 2),
    });
  } catch (e) {
    console.error('alertCritical failed to send:', e.message);
  }
}

module.exports = { logError, alertCritical };
