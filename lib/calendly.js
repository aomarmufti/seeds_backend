// lib/calendly.js
// Thin wrapper around Calendly's v2 API (docs: https://developer.calendly.com).
// Uses a Personal Access Token (CALENDLY_API_TOKEN) rather than a full OAuth
// app — simpler to set up for a single-organization integration like this.
//
// NOT independently verified against a live Calendly account/webhook in this
// environment (no account credentials available here) — written to the
// documented v2 API/webhook payload shape. Verify the invitee.created payload
// shape against a real webhook delivery once a Calendly account is connected,
// in case Calendly has changed field names since these docs were written.

const crypto = require('crypto');

const CALENDLY_API_BASE = 'https://api.calendly.com';

function calendlyRequest(path, options = {}) {
  const token = process.env.CALENDLY_API_TOKEN;
  if (!token) throw new Error('CALENDLY_API_TOKEN is not configured');
  return fetch(`${CALENDLY_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

/**
 * Create a single-use scheduling link for a tutor's Calendly event type.
 * `trackingId` (e.g. a leadId or bookingId) is embedded as a UTM param so
 * it comes back in the invitee.created webhook payload's tracking data,
 * letting us tie the Calendly booking back to the right lead/family
 * without needing a full OAuth-scoped invitee lookup.
 */
async function createSchedulingLink({ eventTypeUri, trackingId }) {
  if (!eventTypeUri) throw new Error('eventTypeUri is required (the tutor\'s Calendly event type)');
  const r = await calendlyRequest('/scheduling_links', {
    method: 'POST',
    body: JSON.stringify({ max_event_count: 1, owner: eventTypeUri, owner_type: 'EventType' }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || `Calendly scheduling link request failed with status ${r.status}`);
  const bookingUrl = data.resource.booking_url;
  return trackingId
    ? `${bookingUrl}${bookingUrl.includes('?') ? '&' : '?'}utm_content=${encodeURIComponent(trackingId)}`
    : bookingUrl;
}

/**
 * Verify a Calendly webhook's signature. Calendly signs with HMAC-SHA256
 * over `${timestamp}.${rawBody}`, sent as `t=<timestamp>,v1=<hex digest>`
 * in the Calendly-Webhook-Signature header.
 */
function verifyWebhookSignature(rawBody, signatureHeader, signingKey) {
  if (!signingKey) throw new Error('CALENDLY_WEBHOOK_SIGNING_KEY is not configured');
  if (!signatureHeader) throw new Error('Missing Calendly-Webhook-Signature header');

  const parts = Object.fromEntries(
    signatureHeader.split(',').map((kv) => kv.split('=').map((s) => s.trim()))
  );
  const { t: timestamp, v1: signature } = parts;
  if (!timestamp || !signature) throw new Error('Malformed Calendly-Webhook-Signature header');

  const expected = crypto
    .createHmac('sha256', signingKey)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(signature, 'hex');
  if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    throw new Error('Calendly webhook signature mismatch');
  }
}

/**
 * Extract the fields we care about from an invitee.created webhook payload.
 * See https://developer.calendly.com/api-docs/ for the full payload shape.
 */
function parseInviteeCreatedPayload(payload) {
  const event = payload.scheduled_event || {};
  return {
    inviteeUri: payload.uri,
    inviteeEmail: payload.email,
    inviteeName: payload.name,
    eventUri: event.uri,
    eventTypeUri: event.event_type,
    startTime: event.start_time,
    endTime: event.end_time,
    trackingId: payload.tracking && payload.tracking.utm_content,
  };
}

module.exports = { createSchedulingLink, verifyWebhookSignature, parseInviteeCreatedPayload };
