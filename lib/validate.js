// lib/validate.js
// Validates request-supplied IDs before they're interpolated into
// PostgREST filter strings (e.g. `/bookings?id=eq.${id}`).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && UUID_RE.test(id);
}

module.exports = { isValidId };
