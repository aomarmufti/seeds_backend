// lib/tutors.js
// Single source of truth for resolving a tutor's meeting link, replacing
// what used to be 4 separately hardcoded name->env-var maps (bookings.js,
// leads.js, webhook.js, lifecycle.js) that had no way of staying in sync
// with each other (SCRUM-28).
const { dbGet, supabaseRequest } = require('./db');

// Fallback for tutors that don't yet have a meet_link set in the `tutors`
// table. Once a tutor's `tutors.meet_link` column is populated (via the
// admin panel or directly), this fallback stops being consulted for them —
// this exists only to avoid changing behaviour for tutors mid-migration.
const ENV_FALLBACK = {
  'Azeem Omar-Mufti': process.env.MEET_LINK_AZEEM,
  'Suleiman': process.env.MEET_LINK_SULEIMAN,
  'Abdul-Moez': process.env.MEET_LINK_ABDULMOEZ,
};
const DEFAULT_LINK = 'https://meet.google.com/seeds-tuition';

async function getMeetingLink(tutorName) {
  if (!tutorName) return DEFAULT_LINK;
  try {
    const rows = await dbGet(`/tutors?name=eq.${encodeURIComponent(tutorName)}&select=meet_link&limit=1`);
    if (rows[0]?.meet_link) return rows[0].meet_link;
  } catch (e) {
    // tutors table unreachable — fall through to the env fallback below
  }
  return ENV_FALLBACK[tutorName] || DEFAULT_LINK;
}

// Upserts a row in the canonical tutors table by name — called when a new
// tutor account is created (auth.js create-tutor/invite-tutor) so every
// tutor gets a real record instead of only existing as a free-text string
// scattered across bookings/payouts. Best-effort: never blocks or fails the
// caller's actual account-creation flow.
async function registerTutor({ name, email, subjects }) {
  if (!name) return;
  try {
    await supabaseRequest('/tutors?on_conflict=name', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: JSON.stringify({ name, email: email || null, subjects: subjects || null }),
    });
  } catch (e) {
    console.warn('registerTutor failed:', e.message);
  }
}

module.exports = { getMeetingLink, registerTutor };
