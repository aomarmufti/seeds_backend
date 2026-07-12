// api/auth.js — POST /api/auth
// Routes by action: create-student | approve-student | invite-tutor | create-tutor
const { applyCors } = require('../lib/cors');
const { supabaseRequest } = require('../lib/db');
const { requireAdmin } = require('../lib/auth');

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Every action here (creating/editing/deactivating accounts, bulk email)
  // is an admin-only operation.
  if (!(await requireAdmin(req, res))) return;

  const { action } = req.body || {};

  // ── CREATE STUDENT ────────────────────────
  if (action === 'create-student') {
    const { fullName, email, subject, level, assignedTutor } = req.body;
    if (!fullName || !email) return res.status(400).json({ error: 'Name and email required' });
    try {
      const adminRes = await supabaseRequest('/auth/v1/admin/users', {
        method: 'POST',
        body: JSON.stringify({ email, email_confirm: true, user_metadata: { full_name: fullName, role: 'student' } }),
      });
      const adminData = await adminRes.json();
      if (!adminRes.ok) throw new Error(adminData.message || JSON.stringify(adminData));
      const userId = adminData.id;
      await supabaseRequest('/rest/v1/profiles', {
        method: 'POST', prefer: 'return=minimal',
        body: JSON.stringify({ id: userId, email, full_name: fullName, role: 'student', subject: subject||null, level: level||null, assigned_tutor: assignedTutor||null }),
      });
      await supabaseRequest('/auth/v1/admin/users/' + userId + '/recovery', { method: 'POST', body: JSON.stringify({}) });
      return res.status(201).json({ success: true, userId });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── APPROVE STUDENT ────────────────────
  if (action === 'approve-student') {
    const { userId, assignedTutor } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      const r = await supabaseRequest('/rest/v1/profiles?id=eq.' + userId,
        { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ role: 'student', assigned_tutor: assignedTutor||null }) }
      );
      if (!r.ok) { const d = await r.json(); throw new Error(JSON.stringify(d)); }
      await supabaseRequest('/auth/v1/admin/users/' + userId + '/recovery', { method: 'POST', body: JSON.stringify({}) });
      return res.status(200).json({ success: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── INVITE TUTOR (sends magic link, account created on signup) ─────
  if (action === 'invite-tutor') {
    const { fullName, email, subjects } = req.body;
    if (!fullName || !email) return res.status(400).json({ error: 'Name and email required' });
    try {
      // Create a pending_tutor account and send magic link
      const adminRes = await supabaseRequest('/auth/v1/admin/users', {
        method: 'POST',
        body: JSON.stringify({ email, email_confirm: true, user_metadata: { full_name: fullName, role: 'pending_tutor', subjects } }),
      });
      const adminData = await adminRes.json();
      if (!adminRes.ok) throw new Error(adminData.message || JSON.stringify(adminData));
      const userId = adminData.id;
      await supabaseRequest('/rest/v1/profiles', {
        method: 'POST', prefer: 'return=minimal',
        body: JSON.stringify({ id: userId, email, full_name: fullName, role: 'pending', tutor_name: fullName }),
      });
      // Send magic link invite
      await supabaseRequest('/auth/v1/admin/users/' + userId + '/recovery', { method: 'POST', body: JSON.stringify({}) });
      return res.status(201).json({ success: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── CREATE TUTOR DIRECTLY ─────────────────
  if (action === 'create-tutor') {
    const { fullName, email, tutorName, subjects } = req.body;
    if (!fullName || !email) return res.status(400).json({ error: 'Name and email required' });
    try {
      const adminRes = await supabaseRequest('/auth/v1/admin/users', {
        method: 'POST',
        body: JSON.stringify({ email, email_confirm: true, user_metadata: { full_name: fullName, role: 'tutor' } }),
      });
      const adminData = await adminRes.json();
      if (!adminRes.ok) throw new Error(adminData.message || JSON.stringify(adminData));
      const userId = adminData.id;
      await supabaseRequest('/rest/v1/profiles', {
        method: 'POST', prefer: 'return=minimal',
        body: JSON.stringify({ id: userId, email, full_name: fullName, role: 'tutor', tutor_name: tutorName||fullName }),
      });
      await supabaseRequest('/auth/v1/admin/users/' + userId + '/recovery', { method: 'POST', body: JSON.stringify({}) });
      return res.status(201).json({ success: true, userId });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── EDIT STUDENT ────────────────────
  if (action === 'edit-student') {
    const { userId, fullName, subject, level, assignedTutor } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      const updates = {};
      if (fullName) updates.full_name = fullName;
      if (subject !== undefined) updates.subject = subject;
      if (level !== undefined) updates.level = level;
      if (assignedTutor !== undefined) updates.assigned_tutor = assignedTutor;
      const r = await supabaseRequest('/rest/v1/profiles?id=eq.' + userId,
        { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(updates) }
      );
      if (!r.ok) { const d = await r.json(); throw new Error(JSON.stringify(d)); }
      return res.status(200).json({ success: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── EDIT TUTOR ───────────────────
  if (action === 'edit-tutor') {
    const { userId, fullName, tutorName, email } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      const profileUpdates = {};
      if (fullName) profileUpdates.full_name = fullName;
      if (tutorName) profileUpdates.tutor_name = tutorName;
      if (email) profileUpdates.email = email;
      const r = await supabaseRequest('/rest/v1/profiles?id=eq.' + userId,
        { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(profileUpdates) }
      );
      if (!r.ok) { const d = await r.json(); throw new Error(JSON.stringify(d)); }
      if (email) {
        await supabaseRequest('/auth/v1/admin/users/' + userId,
          { method: 'PUT', body: JSON.stringify({ email }) }
        );
      }
      return res.status(200).json({ success: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── DEACTIVATE TUTOR ─────────────────
  if (action === 'deactivate-tutor') {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      // Ban the user in Supabase auth
      await supabaseRequest('/auth/v1/admin/users/' + userId,
        { method: 'PUT', body: JSON.stringify({ ban_duration: '876600h' }) } // ~100 years
      );
      // Mark profile as deactivated
      await supabaseRequest('/rest/v1/profiles?id=eq.' + userId,
        { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ role: 'deactivated' }) }
      );
      return res.status(200).json({ success: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── BULK EMAIL (announcement) ─────────────────
  if (action === 'bulk-email') {
    const { subject: emailSubject, body: emailBody, to } = req.body;
    // to: 'all-students' | 'all-tutors' | 'all'
    if (!emailSubject || !emailBody) return res.status(400).json({ error: 'subject and body required' });
    try {
      const { dbGet } = require('../lib/db');
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: 'smtp.resend.com', port: 465, secure: true,
        auth: { user: 'resend', pass: process.env.RESEND_API_KEY },
      });
      let emails = [];
      if (to === 'all-students' || to === 'all') {
        const students = await dbGet('/students?select=parent_email&order=created_at.desc');
        emails.push(...students.map(s => s.parent_email).filter(Boolean));
      }
      if (to === 'all-tutors' || to === 'all') {
        const tutors = await dbGet('/profiles?role=eq.tutor&select=email');
        emails.push(...tutors.map(t => t.email).filter(Boolean));
      }
      emails = [...new Set(emails)]; // deduplicate
      let sent = 0;
      for (const email of emails) {
        try {
          await transporter.sendMail({
            from: `"Seeds Tuition" <${process.env.EMAIL_FROM}>`,
            to: email,
            subject: emailSubject,
            html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
              <div style="background:#0D1B2A;padding:20px 24px;border-radius:12px 12px 0 0">
                <h2 style="font-family:Georgia,serif;color:#fff;margin:0;font-size:20px">Seeds Tuition</h2>
              </div>
              <div style="background:#fff;padding:24px;border:1px solid #E8E8E8;border-top:none;border-radius:0 0 12px 12px">
                <h3 style="color:#0D1B2A;font-family:Georgia,serif;margin-bottom:14px">${emailSubject}</h3>
                <div style="color:#4A5568;font-size:15px;line-height:1.7">${emailBody.replace(/\n/g,'<br>')}</div>
                <div style="margin-top:20px;padding-top:14px;border-top:1px solid #F0EDE8;font-size:12px;color:#A7A7A7">Seeds Tuition · seedstuition.co.uk</div>
              </div>
            </div>`,
          });
          sent++;
        } catch(e) { console.warn('Email failed for', email, e.message); }
      }
      return res.status(200).json({ success: true, sent, total: emails.length });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(400).json({ error: 'Unknown action: ' + action });
};
