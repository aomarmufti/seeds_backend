// lib/pricing.js
// ─────────────────────────────────────────────
// Single source of truth for Seeds pricing.
// All amounts in pence (Stripe requires integer pence for GBP).
// ─────────────────────────────────────────────

const PRICING = {
  trial: {
    label: 'Free Trial Lesson',
    amount: 0,          // £0 — no charge
    currency: 'gbp',
    duration: 30,       // minutes
    description: '30-minute diagnostic lesson — no payment required',
  },
  gcse: {
    label: 'GCSE 1:1 Lesson',
    amount: 4000,       // £40.00
    currency: 'gbp',
    duration: 55,
    description: 'GCSE Mathematics / Sciences / History / Arabic — 55 min',
  },
  alevel: {
    label: 'A-Level 1:1 Lesson',
    amount: 4500,       // £45.00
    currency: 'gbp',
    duration: 55,
    description: 'A-Level Mathematics / Sciences / History / Arabic — 55 min',
  },
  group: {
    label: 'Group Past-Paper Session',
    amount: 2000,       // £20.00
    currency: 'gbp',
    duration: 60,
    description: 'Group past-paper working session — 60 min — recorded',
  },
};

// Resolve lesson type from student level
function resolvePrice(lessonType, studentLevel) {
  if (lessonType === 'trial') return PRICING.trial;
  if (lessonType === 'group') return PRICING.group;
  if (studentLevel === 'alevel') return PRICING.alevel;
  return PRICING.gcse; // default to GCSE
}

module.exports = { PRICING, resolvePrice };
