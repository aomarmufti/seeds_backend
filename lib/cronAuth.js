// lib/cronAuth.js
// Verifies the caller is Vercel's cron scheduler (which sends
// Authorization: Bearer $CRON_SECRET automatically) before running a
// scheduled job body. Fails closed if CRON_SECRET isn't configured.

function requireCronSecret(req, res) {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.authorization;
  if (!secret || header !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

module.exports = { requireCronSecret };
