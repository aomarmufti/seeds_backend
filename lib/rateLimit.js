// lib/rateLimit.js — IP-based rate limiting for public/unauthenticated
// endpoints (SCRUM-20), backed by a Postgres function (check_rate_limit)
// rather than a new third-party service like Upstash — Supabase is already
// the platform's database, and an atomic upsert there is correct across
// concurrent serverless invocations, unlike an in-memory counter would be.
const { dbRpc } = require('./db');

function getClientIp(req) {
  const fwd = req.headers && req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Returns true if under the limit, false if it should be rejected. Fails
// open (allows the request) if the check itself errors — a broken rate
// limiter should never be the reason bookings/payments stop working.
async function checkRateLimit(key, max, windowSeconds) {
  try {
    return await dbRpc('check_rate_limit', { p_key: key, p_max: max, p_window_seconds: windowSeconds });
  } catch (e) {
    console.warn('Rate limit check failed, allowing request:', e.message);
    return true;
  }
}

// Checks the caller's IP under `${scope}:ip:<ip>` and, if over `max` requests
// per `windowSeconds`, sends a 429 and returns false. Returns true if the
// caller should be allowed to proceed.
async function rateLimitOrReject(req, res, scope, { max, windowSeconds }) {
  const ip = getClientIp(req);
  const allowed = await checkRateLimit(`${scope}:ip:${ip}`, max, windowSeconds);
  if (!allowed) {
    res.status(429).json({ error: 'Too many requests — please try again shortly.' });
    return false;
  }
  return true;
}

module.exports = { getClientIp, checkRateLimit, rateLimitOrReject };
