// lib/auth.js
// Verifies a caller's Supabase session (sent as Authorization: Bearer <token>
// by the frontend, from sbClient.auth.getSession()) and resolves their role.
// Verification is delegated to Supabase's own Auth server rather than
// decoding the JWT locally, so this doesn't need to know the project's
// signing algorithm/secret or add a JWT-library dependency.

const { dbGet } = require('./db');

async function getAuthedUser(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !anonKey) return null;

  try {
    const userRes = await fetch(`${url}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
    });
    if (!userRes.ok) return null;
    const user = await userRes.json();
    if (!user || !user.id) return null;

    const profiles = await dbGet(`/profiles?id=eq.${user.id}&limit=1`);
    const role = profiles[0]?.role || null;

    return { id: user.id, email: user.email, role };
  } catch (e) {
    return null;
  }
}

// Sends 401 and returns null if the caller isn't an authenticated admin;
// otherwise returns the authed user so the caller can proceed.
async function requireAdmin(req, res) {
  const authed = await getAuthedUser(req);
  if (!authed || authed.role !== 'admin') {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return authed;
}

module.exports = { getAuthedUser, requireAdmin };
