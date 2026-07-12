// api/bookings.js — handles confirm, ics, remind via ?action=
// Replaces api/bookings/confirm.js, api/bookings/ics.js, api/bookings/remind.js
// Routes: POST ?action=confirm | GET ?action=ics | GET/POST ?action=remind

const { applyCors } = require('../lib/cors');
const { resolvePrice } = require('../lib/pricing');
const { sendBookingConfirmation, sendLessonReminder } = require('../lib/reminders');
const { generateICS } = require('../lib/calendar');
const { dbPost, dbGet } = require('../lib/db');

const MEET_LINKS = {
  'Azeem': process.env.MEET_LINK_AZEEM,
  'Azeem Omar-Mufti': process.env.MEET_LINK_AZEEM,
  'Suleiman': process.env.MEET_LINK_SULEIMAN,
  'Abdul-Moez': process.env.MEET_LINK_ABDULMOEZ,
};

function getMeetingLink(tutorName) {
  return MEET_LINKS[tutorName] || 'https://meet.google.com/seeds-tuition';
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  const action = req.query.action;

  // ── ICS download ─────────────────────────────────────────────────────────
  if (action === 'ics') {
    try {
      const { tutorName, subject, lessonType, studentLevel,
              startTime, studentName, studentEmail } = req.query;
      const pricing = resolvePrice(lessonType, studentLevel);
      const meetingLink = getMeetingLink(tutorName);
      const icsContent = generateICS({
        studentName: studentName || 'Student',
        tutorName, subject, lessonType,
        startTime: new Date(startTime),
        durationMins: pricing.duration,
        meetingLink,
        studentEmail: studentEmail || '',
      });
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="seeds-lesson.ics"');
      return res.status(200).send(icsContent);
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── Daily reminder cron ───────────────────────────────────────────────────
  if (action === 'remind' || (!action && req.method === 'GET')) {
    try {
      const manual = req.body && Object.keys(req.body || {}).length ? req.body : null;
      if (manual) {
        if (!manual.parentEmail || !manual.startTime)
          return res.status(400).json({ error: 'parentEmail and startTime required' });
        await sendLessonReminder(manual);
        return res.status(200).json({ success: true, message: `Reminder sent to ${manual.parentEmail}` });
      }
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const endOfDay   = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
      const bookings = await dbGet(
        `/bookings?status=eq.confirmed&start_time=gte.${startOfDay}&start_time=lt.${endOfDay}` +
        `&select=*,students(student_name,parent_email)`
      );
      let sent = 0; const errors = [];
      for (const b of bookings) {
        const email = b.students && b.students.parent_email;
        if (!email) continue;
        // Notify student
        try {
          await sendLessonReminder({
            studentName: b.students.student_name || 'your student',
            parentName:  b.students.student_name || '',
            parentEmail: email,
            tutorName:   b.tutor_name,
            subject:     b.subject,
            meetingLink: b.meet_link || getMeetingLink(b.tutor_name),
            startTime:   b.start_time,
          });
          sent++;
        } catch(e) { errors.push(`${email}: ${e.message}`); }

        // Also notify tutor
        try {
          const { dbGet } = require('../lib/db');
          const profiles = await dbGet(`/profiles?tutor_name=eq.${encodeURIComponent(b.tutor_name)}&limit=1`);
          const tutorEmail = profiles[0]?.email;
          if (tutorEmail) {
            const nodemailer = require('nodemailer');
            const t = nodemailer.createTransport({
              host: 'smtp.resend.com', port: 465, secure: true,
              auth: { user: 'resend', pass: process.env.RESEND_API_KEY },
            });
            const time = new Date(b.start_time).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
            await t.sendMail({
              from: `"Seeds Tuition" <${process.env.EMAIL_FROM}>`,
              to: tutorEmail,
              subject: `Today's lesson: ${b.students?.student_name} at ${time}`,
              html: `<div style="font-family:Arial,sans-serif;max-width:500px;padding:20px">
                <h2 style="color:#0D1B2A;font-family:Georgia,serif">📅 Lesson reminder</h2>
                <p>You have a <strong>${b.subject}</strong> lesson today with <strong>${b.students?.student_name}</strong> at <strong>${time}</strong>.</p>
                ${b.meet_link ? `<a href="${b.meet_link}" style="display:inline-block;background:#0D1B2A;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:700">Join lesson →</a>` : ''}
              </div>`,
            });
          }
        } catch(tutorErr) { console.warn('Tutor reminder failed:', tutorErr.message); }
      }
      return res.status(200).json({
        success: true,
        message: `Cron: ${sent}/${bookings.length} reminded.`,
        errors: errors.length ? errors : undefined,
      });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── Confirm booking ───────────────────────────────────────────────────────
  if (action === 'confirm' || (!action && req.method === 'POST')) {
    try {
      const {
        studentName, parentName, parentEmail, parentPhone,
        tutorName, subject, lessonType, studentLevel,
        startTime, paymentIntentId,
      } = req.body || {};

      if (!parentEmail || !startTime || !tutorName)
        return res.status(400).json({ error: 'Missing required fields' });

      const pricing = resolvePrice(lessonType, studentLevel);
      const meetingLink = getMeetingLink(tutorName);

      // Conflict check — prevent double-booking a tutor
      if (tutorName !== 'Best available match') {
        const slotEnd = new Date(new Date(startTime).getTime() + pricing.duration * 60000);
        const conflicts = await dbGet(
          `/bookings?tutor_name=eq.${encodeURIComponent(tutorName)}&status=neq.cancelled` +
          `&start_time=gte.${new Date(startTime).toISOString()}&start_time=lt.${slotEnd.toISOString()}&limit=1`
        );
        if (conflicts.length) {
          return res.status(409).json({
            error: `${tutorName} is already booked at that time. Please choose a different slot.`,
            conflict: true,
          });
        }
      }
      const existing = await dbGet(`/students?parent_email=eq.${encodeURIComponent(parentEmail)}&limit=1`);
      const student = existing.length
        ? existing[0]
        : await dbPost('/students', {
            parent_name: parentName || studentName,
            parent_email: parentEmail,
            parent_phone: parentPhone || null,
            student_name: studentName,
          });

      await dbPost('/bookings', {
        student_id: student.id,
        tutor_name: tutorName, subject,
        lesson_type: lessonType || 'trial',
        start_time: startTime,
        duration_mins: pricing.duration,
        fee_pence: pricing.amount,
        stripe_payment_intent_id: paymentIntentId || null,
        status: 'confirmed',
        meet_link: meetingLink,
      });

      await sendBookingConfirmation({
        studentName, parentName: parentName || studentName,
        parentEmail, parentPhone: parentPhone || null,
        tutorName, subject, lessonType, studentLevel,
        startTime, durationMins: pricing.duration,
        meetingLink, amountPence: pricing.amount,
        paymentIntentId: paymentIntentId || null,
      });

      return res.status(200).json({ success: true, meetingLink });
    } catch(e) {
      console.error('confirm error:', e.message);
      // DB-level guards (exclusion/unique constraints) are the backstop for the
      // race this handler's own pre-check can't fully close; translate their
      // violations into the same friendly response as the pre-check above.
      if (e.message.includes('bookings_no_tutor_overlap')) {
        return res.status(409).json({
          error: `${req.body?.tutorName || 'This tutor'} is already booked at that time. Please choose a different slot.`,
          conflict: true,
        });
      }
      if (e.message.includes('bookings_one_trial_per_student')) {
        return res.status(409).json({
          error: 'This student has already used their free trial lesson.',
          conflict: true,
        });
      }
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(400).json({ error: 'Unknown action. Use ?action=confirm|ics|remind' });
};
