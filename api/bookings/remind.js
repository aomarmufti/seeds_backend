// api/bookings/remind.js
// POST or GET /api/bookings/remind
// Sends a lesson reminder email. Called daily by Vercel Cron (see vercel.json).
// In production this would query a database for today's lessons.

const { applyCors } = require('../../lib/cors');
const { sendLessonReminder } = require('../../lib/reminders');

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  // Vercel cron sends a GET request — accept both GET and POST
  try {
    // When triggered by cron with no body, there's nothing to send yet
    // (a real DB query would go here). When called manually with a booking
    // object in the body, it sends that reminder.
    const booking = req.body && Object.keys(req.body).length ? req.body : null;

    if (!booking) {
      return res.status(200).json({
        success: true,
        message: 'Reminder cron ran — no bookings to remind (connect a database to enable automatic daily reminders).',
      });
    }

    if (!booking.parentEmail || !booking.startTime) {
      return res.status(400).json({ error: 'parentEmail and startTime are required' });
    }

    await sendLessonReminder(booking);
    res.status(200).json({ success: true, message: `Reminder sent to ${booking.parentEmail}` });
  } catch (err) {
    console.error('Reminder error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
