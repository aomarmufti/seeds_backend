// api/bookings/remind.js
// Daily cron (Vercel, 7am) — sends reminder emails for today's confirmed lessons.
// Can also be called manually with a booking object in the body.

const { applyCors } = require('../../lib/cors');
const { dbGet } = require('../../lib/db');
const { sendLessonReminder } = require('../../lib/reminders');

const MEET_LINKS = {
  'Azeem Omar-Mufti': process.env.MEET_LINK_AZEEM,
  'Suleiman': process.env.MEET_LINK_SULEIMAN,
  'Abdul-Moez': process.env.MEET_LINK_ABDULMOEZ,
};

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  try {
    // Manual single-booking mode (body provided)
    const manual = req.body && Object.keys(req.body).length ? req.body : null;
    if (manual) {
      if (!manual.parentEmail || !manual.startTime) {
        return res.status(400).json({ error: 'parentEmail and startTime are required' });
      }
      await sendLessonReminder(manual);
      return res.status(200).json({ success: true, message: `Reminder sent to ${manual.parentEmail}` });
    }

    // Cron mode — find today's confirmed lessons and remind each
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

    const bookings = await dbGet(
      `/bookings?status=eq.confirmed&start_time=gte.${startOfDay}&start_time=lt.${endOfDay}` +
      `&select=*,students(student_name,parent_email)`
    );

    let sent = 0;
    const errors = [];
    for (const b of bookings) {
      const email = b.students && b.students.parent_email;
      if (!email) continue;
      try {
        await sendLessonReminder({
          studentName: b.students.student_name || 'your student',
          parentName: b.students.student_name || '',
          parentEmail: email,
          tutorName: b.tutor_name,
          subject: b.subject,
          meetingLink: b.meet_link || MEET_LINKS[b.tutor_name] || 'https://meet.google.com/seeds-tuition',
          startTime: b.start_time,
        });
        sent++;
      } catch (e) {
        errors.push(`${email}: ${e.message}`);
      }
    }

    return res.status(200).json({
      success: true,
      message: `Reminder cron: ${sent} of ${bookings.length} today's lessons reminded.`,
      errors: errors.length ? errors : undefined,
    });
  } catch (err) {
    console.error('Reminder error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
