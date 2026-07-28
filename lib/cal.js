// lib/cal.js
// Thin helper for Cal.com webhook verification + payload parsing. Replaces
// lib/calendly.js — Calendly's free plan only allows ONE active event type
// account-wide, which broke every tutor's booking twice (SCRUM-67's
// consolidation, then again when the trial/plan lapsed entirely). Cal.com's
// free individual plan allows unlimited event types, and — unlike the
// shared-account workaround Calendly forced — each tutor gets their own
// Cal.com account, so bookings genuinely reflect each tutor's own calendar.
//
// No scheduling-link-minting or booking-lookup API wrapper here (unlike
// lib/calendly.js's createSchedulingLink/getScheduledEvent): each tutor's
// Cal.com account is independent, so there's no single account-wide API
// token this backend could use to call the Cal.com API on every tutor's
// behalf. Instead, tutors.cal_*_link stores each tutor's plain public
// booking URL directly (embedded as-is, no per-use link minting needed —
// Cal.com's own calendar already prevents double-booking a slot), and the
// frontend reads the booked start/end time directly from the embed's
// `bookingSuccessful` postMessage payload rather than a server round-trip
// (Cal.com's postMessage includes it directly, unlike Calendly's, which
// only gave an event URI and required this backend to look the time up).
//
// NOT independently verified against a live Cal.com webhook in this
// environment (no live delivery available here) — written to Cal.com's
// documented v2 webhook payload/signature shape. Verify the
// BOOKING_CREATED payload shape and the X-Cal-Signature-256 header against
// a real webhook delivery once a tutor's Cal.com account has one
// configured, in case the shape differs from what's documented here.

const crypto = require('crypto');

/**
 * Verify a Cal.com webhook's signature. Cal.com signs the raw request body
 * with HMAC-SHA256 using the webhook endpoint's own signing secret, sent as
 * a plain hex digest in the `X-Cal-Signature-256` header — no timestamp
 * component, unlike Calendly/Stripe's `t=...,v1=...` scheme.
 */
function verifyWebhookSignature(rawBody, signatureHeader, signingSecret) {
  if (!signingSecret) throw new Error('CAL_WEBHOOK_SIGNING_SECRET is not configured');
  if (!signatureHeader) throw new Error('Missing X-Cal-Signature-256 header');

  const expected = crypto.createHmac('sha256', signingSecret).update(rawBody).digest('hex');

  let expectedBuf, actualBuf;
  try {
    expectedBuf = Buffer.from(expected, 'hex');
    actualBuf = Buffer.from(signatureHeader, 'hex');
  } catch (e) {
    throw new Error('Malformed X-Cal-Signature-256 header');
  }
  if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    throw new Error('Cal.com webhook signature mismatch');
  }
}

/**
 * Extract the fields we care about from a BOOKING_CREATED (or CANCELLED)
 * webhook payload. See https://cal.com/docs/core-features/webhooks for the
 * documented payload shape.
 */
function parseBookingPayload(payload) {
  const attendee = (payload.attendees && payload.attendees[0]) || {};
  return {
    bookingUid: payload.uid,
    attendeeEmail: attendee.email,
    attendeeName: attendee.name,
    startTime: payload.startTime,
    endTime: payload.endTime,
    eventTypeSlug: payload.type,
    // Cal.com's public booking page accepts a `metadata[key]=value` query
    // param, which it stores on the booking and echoes back here — used
    // the same way Calendly's utm_content tracking param carried our own
    // leadId through to the webhook (see api/leads.js's assign-tutor flow).
    trackingId: payload.metadata && payload.metadata.trackingId,
  };
}

module.exports = { verifyWebhookSignature, parseBookingPayload };
