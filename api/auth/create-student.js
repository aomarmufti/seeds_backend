// api/auth/create-student.js
const { applyCors } = require('../../lib/cors');
const { supabaseRequest } = require('../../lib/db');

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { fullName, email, subject, level, assignedTutor } = req.body || {};
  if (!fullName || !email) return res.status(400).json({ error: 'Name and email required' });
  try {
    const adminRes = await supabaseRequest('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email, email_confirm: true,
        user_metadata: { full_name: fullName, role: 'student' },
      }),
    });
    const adminData = await adminRes.json();
    if (!adminRes.ok) throw new Error(adminData.message || JSON.stringify(adminData));
    const userId = adminData.id;
    await supabaseRequest('/rest/v1/profiles', {
      method: 'POST', prefer: 'return=minimal',
      body: JSON.stringify({
        id: userId, email, full_name: fullName,
        role: 'student', subject: subject || null,
        level: level || null, assigned_tutor: assignedTutor || null,
      }),
    });
    await supabaseRequest('/auth/v1/admin/users/' + userId + '/recovery', {
      method: 'POST', body: JSON.stringify({}),
    });
    return res.status(201).json({ success: true, userId });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
