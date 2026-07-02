// api/auth/approve-student.js
const { applyCors } = require('../../lib/cors');
const { supabaseRequest } = require('../../lib/db');

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { userId, assignedTutor } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const r = await supabaseRequest(
      '/rest/v1/profiles?id=eq.' + userId,
      { method: 'PATCH', prefer: 'return=minimal',
        body: JSON.stringify({ role: 'student', assigned_tutor: assignedTutor || null }) }
    );
    if (!r.ok) { const d = await r.json(); throw new Error(JSON.stringify(d)); }
    await supabaseRequest('/auth/v1/admin/users/' + userId + '/recovery', {
      method: 'POST', body: JSON.stringify({}),
    });
    return res.status(200).json({ success: true });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
