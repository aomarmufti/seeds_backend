// lib/db.js — Supabase REST client (no npm package needed)
// Uses fetch + service key, works in Vercel serverless CommonJS.

function supabaseRequest(path, options = {}) {
  const url = process.env.SUPABASE_URL;
  const key  = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_KEY not set');

  return fetch(`${url}/rest/v1${path}`, {
    ...options,
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': options.prefer || 'return=representation',
      ...(options.headers || {}),
    },
  });
}

async function dbGet(path) {
  const r = await supabaseRequest(path, { method: 'GET' });
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || JSON.stringify(data));
  return data;
}

async function dbPost(path, body) {
  const r = await supabaseRequest(path, { method: 'POST', body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || JSON.stringify(data));
  return Array.isArray(data) ? data[0] : data;
}

async function dbPatch(path, body) {
  const r = await supabaseRequest(path, {
    method: 'PATCH', body: JSON.stringify(body), prefer: 'return=representation',
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || JSON.stringify(data));
  return data;
}

module.exports = { supabaseRequest, dbGet, dbPost, dbPatch };
