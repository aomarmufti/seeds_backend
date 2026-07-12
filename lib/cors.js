// lib/cors.js
// Shared CORS + preflight handling for all serverless endpoints.
// Only the configured frontend origin(s) get Access-Control-Allow-Origin —
// unrecognized origins get no CORS header, which browsers treat as a block.

const DEFAULT_ALLOWED_ORIGINS = [
  'https://seedsinstitute.co.uk',
  'https://www.seedsinstitute.co.uk',
  'https://seeds-frontend.vercel.app',
  'https://seeds-frontend-seedsacademy.vercel.app',
  'https://seeds-frontend-git-main-seedsacademy.vercel.app',
];

function getAllowedOrigins() {
  const fromEnv = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_ALLOWED_ORIGINS;
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && getAllowedOrigins().includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true; // signals the caller to stop
  }
  return false;
}

module.exports = { applyCors };
