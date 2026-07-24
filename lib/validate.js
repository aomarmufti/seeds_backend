// lib/validate.js
// Validates request-supplied IDs before they're interpolated into
// PostgREST filter strings (e.g. `/bookings?id=eq.${id}`).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && UUID_RE.test(id);
}

// Email lookups/writes against students.parent_email were done with mixed
// casing across the codebase (Supabase auth emails, client-typed emails
// from the public wizard, Calendly invitee emails) — a `parent_email=eq.`
// filter is case-sensitive, so the same family could silently end up with
// two different student rows (or a lookup that finds nothing) depending on
// which flow they came through. Normalize everywhere an email is used to
// look up or create a students/leads row.
function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

module.exports = { isValidId, normalizeEmail };
