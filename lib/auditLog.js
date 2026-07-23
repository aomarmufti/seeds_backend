// lib/auditLog.js
// Records an admin action to admin_audit_log. Best-effort: a logging
// failure must never block the admin action itself, so callers should
// not await this in a way that surfaces its errors to the response —
// call it and let it log its own failures instead.
const { supabaseRequest } = require('./db');

async function logAdminAction({ actor, action, targetType, targetId, details }) {
  try {
    const r = await supabaseRequest('/admin_audit_log', {
      method: 'POST',
      prefer: 'return=minimal',
      body: JSON.stringify({
        actor,
        action,
        target_type: targetType || null,
        target_id: targetId || null,
        details: details || null,
      }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      console.error('Audit log write failed:', body.message || r.status);
    }
  } catch (e) {
    console.error('Audit log write failed:', e.message);
  }
}

module.exports = { logAdminAction };
