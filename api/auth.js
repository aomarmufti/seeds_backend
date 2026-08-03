// api/auth.js — POST /api/auth
// Routes by action: create-student | approve-student | invite-tutor | create-tutor
//   | deactivate-account | deactivate-tutor | reactivate-account
//   | delete-account | delete-tutor
//
// Deactivate and delete are deliberately different operations: deactivating
// keeps every record and is reversible, deleting is permanent and is refused
// wherever there is history to lose. See SCRUM-97.
const { applyCors } = require('../lib/cors');
const { supabaseRequest, supabaseAdminRequest, dbGet } = require('../lib/db');
const { requireAdmin } = require('../lib/auth');
const { logAdminAction } = require('../lib/auditLog');
const { registerTutor } = require('../lib/tutors');
const { isValidId, normalizeEmail } = require('../lib/validate');

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Every action here (creating/editing/deactivating accounts, bulk email)
  // is an admin-only operation.
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { action } = req.body || {};
  await logAdminAction({
    actor: admin.email, action,
    targetType: 'user', targetId: req.body?.userId || null,
    details: { email: req.body?.email, to: req.body?.to },
  });

  // ── CREATE STUDENT ────────────────────────
  if (action === 'create-student') {
    const { fullName, email, subject, level, assignedTutor } = req.body;
    if (!fullName || !email) return res.status(400).json({ error: 'Name and email required' });
    try {
      const adminRes = await supabaseAdminRequest('/auth/v1/admin/users', {
        method: 'POST',
        body: JSON.stringify({ email, email_confirm: true, user_metadata: { full_name: fullName, role: 'student' } }),
      });
      const adminData = await adminRes.json();
      if (!adminRes.ok) throw new Error(adminData.message || JSON.stringify(adminData));
      const userId = adminData.id;
      await supabaseRequest('/profiles', {
        method: 'POST', prefer: 'return=minimal',
        body: JSON.stringify({ id: userId, email, full_name: fullName, role: 'student', subject: subject||null, level: level||null, assigned_tutor: assignedTutor||null }),
      });
      await supabaseAdminRequest('/auth/v1/admin/users/' + userId + '/recovery', { method: 'POST', body: JSON.stringify({}) });
      return res.status(201).json({ success: true, userId });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── APPROVE STUDENT ────────────────────
  if (action === 'approve-student') {
    // A pending signup (magic link / Google, see SCRUM-78) has no way to
    // say whether the person is actually a family or a tutor — admin has
    // to make that call. Defaults to 'student' (the original behaviour of
    // this action) but now also accepts role:'tutor', which does the same
    // profile + tutors-table setup as the separate create-tutor action
    // above instead of assigning a tutor to them.
    const { userId, assignedTutor, role, tutorName, subjects } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const approvedRole = role === 'tutor' ? 'tutor' : 'student';
    try {
      const updates = { role: approvedRole };
      if (approvedRole === 'tutor') {
        const profiles = await dbGet(`/profiles?id=eq.${userId}&select=email,full_name&limit=1`);
        const profile = profiles[0];
        const name = tutorName || profile?.full_name;
        updates.tutor_name = name;
        await registerTutor({ name, email: profile?.email, subjects: subjects || null });
      } else {
        updates.assigned_tutor = assignedTutor || null;
      }
      const r = await supabaseRequest('/profiles?id=eq.' + userId,
        { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(updates) }
      );
      if (!r.ok) { const d = await r.json(); throw new Error(JSON.stringify(d)); }
      // SCRUM-85: approving only ever flipped profiles.role, but every
      // Students view (admin's list, the tutor portal's roster, the student
      // portal's own record lookup, lifecycle/booking endpoints) reads the
      // students table — which until now was written only by an actual
      // booking. An approved student was therefore a login with no student
      // record: invisible to admin and unassignable. Upsert it here so
      // approval alone is enough to make them real.
      if (approvedRole === 'student') {
        const profiles = await dbGet(`/profiles?id=eq.${userId}&select=email,full_name&limit=1`);
        const profile = profiles[0];
        const email = (profile?.email || '').trim().toLowerCase();
        if (email) {
          const existing = await dbGet(`/students?parent_email=eq.${encodeURIComponent(email)}&limit=1`);
          if (!existing.length) {
            await supabaseRequest('/students', {
              method: 'POST', prefer: 'return=minimal',
              body: JSON.stringify({
                parent_email: email,
                parent_name: profile?.full_name || email,
                student_name: profile?.full_name || email,
              }),
            });
          }
        }
      }
      await supabaseAdminRequest('/auth/v1/admin/users/' + userId + '/recovery', { method: 'POST', body: JSON.stringify({}) });
      return res.status(200).json({ success: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── ASSIGN / REASSIGN A STUDENT'S TUTOR (SCRUM-86) ────────
  // profiles.assigned_tutor existed but nothing ever wrote to it outside
  // the initial lead assignment, so admin had no way to give a student a
  // tutor (or move them to a different one) after the fact.
  if (action === 'assign-tutor') {
    const { userId, tutorName, studentId } = req.body;
    // A student assigned from a lead has a students row but no auth user yet,
    // so there is no userId to key on — assign against the record instead.
    if (!userId && studentId) {
      if (!isValidId(studentId)) return res.status(400).json({ error: 'Invalid studentId' });
      try {
        const sr = await supabaseRequest(`/students?id=eq.${studentId}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ assigned_tutor: tutorName || null }),
        });
        if (!sr.ok) { const d = await sr.json(); throw new Error(JSON.stringify(d)); }
        return res.status(200).json({ success: true });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }
    if (!userId) return res.status(400).json({ error: 'userId or studentId required' });
    try {
      const r = await supabaseRequest('/profiles?id=eq.' + userId, {
        method: 'PATCH', prefer: 'return=minimal',
        body: JSON.stringify({ assigned_tutor: tutorName || null }),
      });
      if (!r.ok) { const d = await r.json(); throw new Error(JSON.stringify(d)); }
      // profiles is the account record, but every Students view — admin's
      // list, the tutor portal's roster — reads the students table. Writing
      // only profiles meant an assignment made here was invisible in both.
      try {
        const profiles = await dbGet(`/profiles?id=eq.${userId}&select=email&limit=1`);
        const email = profiles[0]?.email;
        if (email) {
          await supabaseRequest(`/students?parent_email=eq.${encodeURIComponent(email)}`, {
            method: 'PATCH', prefer: 'return=minimal',
            body: JSON.stringify({ assigned_tutor: tutorName || null }),
          });
        }
      } catch (syncErr) {
        console.warn('assign-tutor students sync failed:', syncErr.message);
      }
      return res.status(200).json({ success: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── DEACTIVATE ANY ACCOUNT (SCRUM-86) ─────────────────────
  // Same ban-and-mark approach as deactivate-tutor below, but role-agnostic
  // so a student account can be removed too. Never hard-deletes — past
  // bookings, payouts and safeguarding history must survive.
  if (action === 'deactivate-account') {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (userId === admin.id) return res.status(400).json({ error: 'You cannot deactivate your own account' });
    try {
      await supabaseAdminRequest('/auth/v1/admin/users/' + userId,
        { method: 'PUT', body: JSON.stringify({ ban_duration: '876600h' }) }
      );
      await supabaseRequest('/profiles?id=eq.' + userId,
        { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ role: 'deactivated' }) }
      );
      return res.status(200).json({ success: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── REACTIVATE AN ACCOUNT (SCRUM-97) ──────────────────────
  // Deactivation was one-way: the ban lasts a century and the original role
  // is overwritten with 'deactivated', so there was no path back for an
  // account removed by mistake. The role can't be recovered from the profile
  // (it's what got overwritten), so the caller states it.
  if (action === 'reactivate-account') {
    const { userId, role } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const restoredRole = role === 'tutor' ? 'tutor' : 'student';
    try {
      // 'none' is Supabase's way of lifting a ban.
      await supabaseAdminRequest('/auth/v1/admin/users/' + userId,
        { method: 'PUT', body: JSON.stringify({ ban_duration: 'none' }) }
      );
      await supabaseRequest('/profiles?id=eq.' + userId,
        { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ role: restoredRole }) }
      );
      return res.status(200).json({ success: true, role: restoredRole });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── PERMANENTLY DELETE A STUDENT ACCOUNT (SCRUM-97) ───────
  // Deletion is for data that should never have existed — test accounts,
  // duplicates, a signup abandoned before anything happened. It is not the
  // way to remove a family who has left: that is deactivation, which keeps
  // their lessons, invoices and safeguarding history intact.
  //
  // So this refuses wherever history exists, and says what is blocking it.
  // The check is also a practical necessity: bookings reference students(id)
  // with no ON DELETE rule, so deleting underneath them would fail on the
  // foreign key anyway — better to explain than to surface a constraint
  // error. Enrolments cascade from the student row and need no handling.
  if (action === 'delete-account') {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (userId === admin.id) return res.status(400).json({ error: 'You cannot delete your own account' });
    if (!isValidId(userId)) return res.status(400).json({ error: 'Invalid userId' });
    try {
      const profiles = await dbGet(`/profiles?id=eq.${userId}&select=email&limit=1`);
      const profile = profiles[0];
      if (!profile) return res.status(404).json({ error: 'Account not found' });

      const email = normalizeEmail(profile.email || '');
      const students = email
        ? await dbGet(`/students?parent_email=eq.${encodeURIComponent(email)}&select=id`)
        : [];
      const studentIds = students.map((s) => s.id);

      if (studentIds.length) {
        const inList = `(${studentIds.join(',')})`;
        const [bookings, batches] = await Promise.all([
          dbGet(`/bookings?student_id=in.${inList}&select=id&limit=1`),
          dbGet(`/billing_batches?student_id=in.${inList}&select=id&limit=1`),
        ]);
        const blockers = [];
        if (bookings.length) blockers.push('lessons');
        if (batches.length) blockers.push('billing history');
        if (blockers.length) {
          return res.status(409).json({
            error: `This account has ${blockers.join(' and ')} and can't be deleted. Deactivate it instead — that keeps the records and stops them signing in.`,
            blockedBy: blockers,
          });
        }
      }

      for (const id of studentIds) {
        await supabaseRequest(`/students?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' });
      }
      await supabaseRequest(`/profiles?id=eq.${userId}`, { method: 'DELETE', prefer: 'return=minimal' });
      await supabaseAdminRequest('/auth/v1/admin/users/' + userId, { method: 'DELETE' });
      return res.status(200).json({ success: true, deletedStudentRows: studentIds.length });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── PERMANENTLY DELETE A TUTOR ACCOUNT (SCRUM-97) ─────────
  // Same rule as delete-account. A tutor who has taught or been paid is a
  // financial record; only one who never got started can be removed.
  //
  // bookings.tutor_name is a string with no foreign key, so nothing would
  // stop the delete at the database level — which is exactly why the check
  // matters here: it would silently orphan every lesson they taught.
  if (action === 'delete-tutor') {
    const { userId, tutorName } = req.body;
    if (!userId && !tutorName) return res.status(400).json({ error: 'userId or tutorName required' });
    if (userId && userId === admin.id) return res.status(400).json({ error: 'You cannot delete your own account' });
    if (userId && !isValidId(userId)) return res.status(400).json({ error: 'Invalid userId' });
    try {
      let name = tutorName;
      if (!name && userId) {
        const profiles = await dbGet(`/profiles?id=eq.${userId}&select=tutor_name,full_name&limit=1`);
        name = profiles[0]?.tutor_name || profiles[0]?.full_name || null;
      }
      if (!name) return res.status(404).json({ error: 'Tutor not found' });

      const [bookings, payouts] = await Promise.all([
        dbGet(`/bookings?tutor_name=eq.${encodeURIComponent(name)}&select=id&limit=1`),
        dbGet(`/payouts?tutor_name=eq.${encodeURIComponent(name)}&select=id&limit=1`),
      ]);
      const blockers = [];
      if (bookings.length) blockers.push('lessons');
      if (payouts.length) blockers.push('payouts');
      if (blockers.length) {
        return res.status(409).json({
          error: `${name} has ${blockers.join(' and ')} on record and can't be deleted. Deactivate instead — that keeps the history and stops them signing in.`,
          blockedBy: blockers,
        });
      }

      // enrolments.tutor_id is ON DELETE SET NULL, so any pending enrolment
      // pointing here survives as unassigned rather than disappearing.
      await supabaseRequest(`/tutor_accounts?tutor_name=eq.${encodeURIComponent(name)}`, { method: 'DELETE', prefer: 'return=minimal' });
      await supabaseRequest(`/tutors?name=eq.${encodeURIComponent(name)}`, { method: 'DELETE', prefer: 'return=minimal' });
      if (userId) {
        await supabaseRequest(`/profiles?id=eq.${userId}`, { method: 'DELETE', prefer: 'return=minimal' });
        await supabaseAdminRequest('/auth/v1/admin/users/' + userId, { method: 'DELETE' });
      }
      return res.status(200).json({ success: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── INVITE TUTOR (sends magic link, account created on signup) ─────
  if (action === 'invite-tutor') {
    const { fullName, email, subjects } = req.body;
    if (!fullName || !email) return res.status(400).json({ error: 'Name and email required' });
    try {
      // Create a pending_tutor account and send magic link
      const adminRes = await supabaseAdminRequest('/auth/v1/admin/users', {
        method: 'POST',
        body: JSON.stringify({ email, email_confirm: true, user_metadata: { full_name: fullName, role: 'pending_tutor', subjects } }),
      });
      const adminData = await adminRes.json();
      if (!adminRes.ok) throw new Error(adminData.message || JSON.stringify(adminData));
      const userId = adminData.id;
      await supabaseRequest('/profiles', {
        method: 'POST', prefer: 'return=minimal',
        body: JSON.stringify({ id: userId, email, full_name: fullName, role: 'pending', tutor_name: fullName }),
      });
      // Send magic link invite
      await supabaseAdminRequest('/auth/v1/admin/users/' + userId + '/recovery', { method: 'POST', body: JSON.stringify({}) });
      await registerTutor({ name: fullName, email, subjects });
      return res.status(201).json({ success: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── CREATE TUTOR DIRECTLY ─────────────────
  if (action === 'create-tutor') {
    const { fullName, email, tutorName, subjects } = req.body;
    if (!fullName || !email) return res.status(400).json({ error: 'Name and email required' });
    try {
      const adminRes = await supabaseAdminRequest('/auth/v1/admin/users', {
        method: 'POST',
        body: JSON.stringify({ email, email_confirm: true, user_metadata: { full_name: fullName, role: 'tutor' } }),
      });
      const adminData = await adminRes.json();
      if (!adminRes.ok) throw new Error(adminData.message || JSON.stringify(adminData));
      const userId = adminData.id;
      await supabaseRequest('/profiles', {
        method: 'POST', prefer: 'return=minimal',
        body: JSON.stringify({ id: userId, email, full_name: fullName, role: 'tutor', tutor_name: tutorName||fullName }),
      });
      await supabaseAdminRequest('/auth/v1/admin/users/' + userId + '/recovery', { method: 'POST', body: JSON.stringify({}) });
      await registerTutor({ name: tutorName || fullName, email, subjects });
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
      const r = await supabaseRequest('/profiles?id=eq.' + userId,
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
      if (email) profileUpdates.email = email;

      if (tutorName) {
        const existing = await dbGet(`/profiles?id=eq.${userId}&select=tutor_name&limit=1`);
        const oldTutorName = existing[0]?.tutor_name;
        if (oldTutorName && oldTutorName !== tutorName) {
          // Rename via the canonical tutors table (SCRUM-28) rather than
          // patching profiles.tutor_name directly — a DB trigger cascades
          // the new name into bookings/payouts/tutor_accounts/profiles
          // automatically, so it can't silently desync between them.
          await supabaseRequest(`/tutors?name=eq.${encodeURIComponent(oldTutorName)}`, {
            method: 'PATCH', prefer: 'return=minimal',
            body: JSON.stringify({ name: tutorName }),
          });
        } else if (!oldTutorName) {
          profileUpdates.tutor_name = tutorName;
        }
      }

      if (Object.keys(profileUpdates).length) {
        const r = await supabaseRequest('/profiles?id=eq.' + userId,
          { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(profileUpdates) }
        );
        if (!r.ok) { const d = await r.json(); throw new Error(JSON.stringify(d)); }
      }
      if (email) {
        await supabaseAdminRequest('/auth/v1/admin/users/' + userId,
          { method: 'PUT', body: JSON.stringify({ email }) }
        );
      }
      return res.status(200).json({ success: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── TUTOR SCHEDULING LINKS (SCRUM-74) ────────────────────
  // Each tutor's own Cal.com account (unlimited free event types, replacing
  // the single shared Calendly account whose free-plan limit broke every
  // tutor's booking at once) has three public booking links stored on the
  // canonical tutors table, keyed by name — no profiles/userId involved,
  // unlike edit-tutor above, since this doesn't touch login/account fields.
  if (action === 'get-tutor-links') {
    const { tutorName } = req.body;
    if (!tutorName) return res.status(400).json({ error: 'tutorName required' });
    try {
      const rows = await dbGet(`/tutors?name=eq.${encodeURIComponent(tutorName)}&select=cal_lesson_link,cal_consultation_link,cal_trial_link&limit=1`);
      if (!rows.length) return res.status(404).json({ error: 'Unknown tutor' });
      return res.status(200).json({
        calLessonLink: rows[0].cal_lesson_link || '',
        calConsultationLink: rows[0].cal_consultation_link || '',
        calTrialLink: rows[0].cal_trial_link || '',
      });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  if (action === 'edit-tutor-links') {
    const { tutorName, calLessonLink, calConsultationLink, calTrialLink } = req.body;
    if (!tutorName) return res.status(400).json({ error: 'tutorName required' });
    try {
      const updates = {};
      if (calLessonLink !== undefined) updates.cal_lesson_link = calLessonLink || null;
      if (calConsultationLink !== undefined) updates.cal_consultation_link = calConsultationLink || null;
      if (calTrialLink !== undefined) updates.cal_trial_link = calTrialLink || null;
      if (!Object.keys(updates).length) return res.status(400).json({ error: 'No links provided' });
      const r = await supabaseRequest(`/tutors?name=eq.${encodeURIComponent(tutorName)}`, {
        method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(updates),
      });
      if (!r.ok) { const d = await r.json(); throw new Error(JSON.stringify(d)); }
      return res.status(200).json({ success: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── DEACTIVATE TUTOR ─────────────────
  if (action === 'deactivate-tutor') {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      // Ban the user in Supabase auth
      await supabaseAdminRequest('/auth/v1/admin/users/' + userId,
        { method: 'PUT', body: JSON.stringify({ ban_duration: '876600h' }) } // ~100 years
      );
      // Mark profile as deactivated
      await supabaseRequest('/profiles?id=eq.' + userId,
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
                <div style="margin-top:20px;padding-top:14px;border-top:1px solid #F0EDE8;font-size:12px;color:#A7A7A7">Seeds Tuition · seedsinstitute.co.uk</div>
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
