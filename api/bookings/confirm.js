// api/bookings/confirm.js
const { applyCors } = require('../../lib/cors');
const { resolvePrice } = require('../../lib/pricing');
const { sendBookingConfirmation } = require('../../lib/reminders');
const { dbPost, dbGet } = require('../../lib/db');

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
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      studentName, parentName, parentEmail, parentPhone,
      tutorName, subject, lessonType, studentLevel,
      startTime, paymentIntentId,
    } = req.body || {};

    if (!parentEmail || !startTime || !tutorName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const pricing = resolvePrice(lessonType, studentLevel);
    const meetingLink = getMeetingLink(tutorName);

    // ── Upsert student ────────────────────────────────────────────────
    let student;
    const existing = await dbGet(
      `/students?parent_email=eq.${encodeURIComponent(parentEmail)}&limit=1`
    );
    if (existing.length) {
      student = existing[0];
    } else {
      student = await dbPost('/students', {
        parent_name: parentName || studentName,
        parent_email: parentEmail,
        parent_phone: parentPhone || null,
        student_name: studentName,
      });
    }

    // ── Save booking ──────────────────────────────────────────────────
    await dbPost('/bookings', {
      student_id: student.id,
      tutor_name: tutorName,
      subject,
      lesson_type: lessonType || 'trial',
      start_time: startTime,
      duration_mins: pricing.duration,
      fee_pence: pricing.amount,
      stripe_payment_intent_id: paymentIntentId || null,
      status: 'confirmed',
      meet_link: meetingLink,
    });

    // ── Send confirmation email ───────────────────────────────────────
    await sendBookingConfirmation({
      studentName, parentName: parentName || studentName,
      parentEmail, parentPhone: parentPhone || null,
      tutorName, subject, lessonType, studentLevel,
      startTime, durationMins: pricing.duration,
      meetingLink, amountPence: pricing.amount,
      paymentIntentId: paymentIntentId || null,
    });

    res.status(200).json({ success: true, meetingLink });
  } catch (err) {
    console.error('confirm error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
