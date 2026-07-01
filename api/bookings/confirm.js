// api/bookings/confirm.js
// POST /api/bookings/confirm
// Confirms a booking and sends a confirmation email with .ics calendar attachment.

const { applyCors } = require('../../lib/cors');
const { resolvePrice } = require('../../lib/pricing');
const { sendBookingConfirmation } = require('../../lib/reminders');

function getMeetingLink(tutorName) {
  const links = {
    'Azeem': process.env.MEET_LINK_AZEEM,
    'Azeem Omar-Mufti': process.env.MEET_LINK_AZEEM,
    'Suleiman': process.env.MEET_LINK_SULEIMAN,
    'Abdul-Moez': process.env.MEET_LINK_ABDULMOEZ,
  };
  return links[tutorName] || 'https://meet.google.com/seeds-tuition';
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      studentName, parentName, parentEmail, parentPhone,
      tutorName, subject, lessonType, studentLevel,
      startTime, paymentIntentId,
    } = req.body || {};

    if (!parentEmail || !startTime || !tutorName) {
      return res.status(400).json({ error: 'Missing required fields: parentEmail, startTime, tutorName' });
    }

    const pricing = resolvePrice(lessonType, studentLevel);
    const meetingLink = getMeetingLink(tutorName);

    const booking = {
      studentName,
      parentName: parentName || studentName,
      parentEmail,
      parentPhone: parentPhone || null,
      tutorName, subject, lessonType, studentLevel,
      startTime,
      durationMins: pricing.duration,
      meetingLink,
      amountPence: pricing.amount,
      paymentIntentId: paymentIntentId || null,
    };

    await sendBookingConfirmation(booking);

    res.status(200).json({ success: true, message: `Confirmation sent to ${parentEmail}`, meetingLink });
  } catch (err) {
    console.error('Booking confirm error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
