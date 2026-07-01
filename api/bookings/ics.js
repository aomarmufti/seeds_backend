// api/bookings/ics.js
// GET /api/bookings/ics?tutorName=...&subject=...&lessonType=...&startTime=...
// Returns a downloadable .ics calendar file for a lesson.

const { applyCors } = require('../../lib/cors');
const { resolvePrice } = require('../../lib/pricing');
const { generateICS } = require('../../lib/calendar');

function getMeetingLink(tutorName) {
  const links = {
    'Azeem': process.env.MEET_LINK_AZEEM,
    'Azeem Omar-Mufti': process.env.MEET_LINK_AZEEM,
    'Suleiman': process.env.MEET_LINK_SULEIMAN,
    'Abdul-Moez': process.env.MEET_LINK_ABDULMOEZ,
  };
  return links[tutorName] || 'https://meet.google.com/seeds-tuition';
}

module.exports = (req, res) => {
  if (applyCors(req, res)) return;

  try {
    const {
      tutorName, subject, lessonType, studentLevel,
      startTime, studentName, studentEmail,
    } = req.query || {};

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
    res.status(200).send(icsContent);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
