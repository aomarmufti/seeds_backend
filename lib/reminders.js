// lib/reminders.js
// ─────────────────────────────────────────────
// Sends lesson confirmation + reminder emails/SMS.
// Email via Resend (free 3,000/month).
// SMS via Twilio (optional — falls back to email only if not configured).
// ─────────────────────────────────────────────

const nodemailer = require('nodemailer');
const { generateICS } = require('./calendar');

// ── EMAIL ─────────────────────────────────────

// Resend acts as an SMTP relay — free tier, deliverable
function getMailTransport() {
  return nodemailer.createTransport({
    host: 'smtp.resend.com',
    port: 465,
    secure: true,
    auth: {
      user: 'resend',
      pass: process.env.RESEND_API_KEY,
    },
  });
}

/**
 * Send booking confirmation email with .ics calendar attachment.
 */
async function sendBookingConfirmation(booking) {
  const {
    studentName, parentName, parentEmail, parentPhone,
    tutorName, subject, lessonType, studentLevel,
    startTime, durationMins, meetingLink, amountPence,
  } = booking;

  const icsContent = generateICS({
    studentName,
    tutorName,
    subject,
    lessonType,
    startTime: new Date(startTime),
    durationMins,
    meetingLink,
    studentEmail: parentEmail,
  });

  const dateStr = new Date(startTime).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const timeStr = new Date(startTime).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit',
  });

  const isFree = amountPence === 0;
  const amountStr = isFree ? 'Free' : `£${(amountPence / 100).toFixed(2)}`;
  const isGroup = lessonType === 'group';

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif; background: #f5f5f0; margin: 0; padding: 24px; }
    .wrap { max-width: 540px; margin: 0 auto; background: #fff; border-radius: 16px; overflow: hidden; }
    .header { background: #0D1B2A; padding: 28px 32px; }
    .header h1 { font-family: Georgia, serif; font-size: 24px; color: #fff; margin: 0 0 4px; }
    .header p { font-size: 13px; color: rgba(255,255,255,.5); margin: 0; }
    .body { padding: 28px 32px; }
    .confirm-tag { background: rgba(200,161,90,0.12); border: 1px solid rgba(200,161,90,0.3); color: #C8A15A; font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; padding: 4px 10px; border-radius: 20px; display: inline-block; margin-bottom: 16px; }
    h2 { font-family: Georgia, serif; font-size: 22px; color: #0D1B2A; margin: 0 0 20px; }
    .details-card { background: #FAF8F4; border-radius: 12px; padding: 18px 20px; margin-bottom: 20px; }
    .detail-row { display: flex; justify-content: space-between; padding: 7px 0; font-size: 14px; border-bottom: 1px solid #E8E8E8; }
    .detail-row:last-child { border-bottom: none; font-weight: 700; }
    .detail-label { color: #718096; }
    .detail-value { color: #0D1B2A; font-weight: 600; text-align: right; }
    .join-btn { display: block; background: #0D1B2A; color: #fff; text-decoration: none; text-align: center; padding: 14px 20px; border-radius: 10px; font-weight: 700; font-size: 15px; margin-bottom: 16px; }
    .note { font-size: 12px; color: #A7A7A7; line-height: 1.6; }
    .footer { background: #F5F0E8; padding: 16px 32px; font-size: 12px; color: #A7A7A7; text-align: center; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <h1>Seeds</h1>
      <p>GCSE &amp; A-Level Tuition</p>
    </div>
    <div class="body">
      <div class="confirm-tag">✓ Booking Confirmed</div>
      <h2>Your lesson is booked, ${parentName || studentName}.</h2>
      <div class="details-card">
        <div class="detail-row"><span class="detail-label">Student</span><span class="detail-value">${studentName}</span></div>
        <div class="detail-row"><span class="detail-label">Subject</span><span class="detail-value">${subject}</span></div>
        <div class="detail-row"><span class="detail-label">Tutor</span><span class="detail-value">${tutorName}</span></div>
        <div class="detail-row"><span class="detail-label">Date</span><span class="detail-value">${dateStr}</span></div>
        <div class="detail-row"><span class="detail-label">Time</span><span class="detail-value">${timeStr}</span></div>
        <div class="detail-row"><span class="detail-label">Duration</span><span class="detail-value">${durationMins} minutes</span></div>
        ${isGroup ? '<div class="detail-row"><span class="detail-label">Format</span><span class="detail-value">Group session · Recorded</span></div>' : ''}
        <div class="detail-row"><span class="detail-label">Total paid</span><span class="detail-value">${amountStr}</span></div>
      </div>
      <a href="${meetingLink}" class="join-btn">Join on Google Meet / Zoom →</a>
      <p class="note">
        We've attached a calendar invite (.ics) to this email — tap it to add the lesson to Apple Calendar, Google Calendar, or Outlook.<br><br>
        ${isGroup ? 'This group session will be recorded and available in your Seeds portal within 30 minutes of completion.' : 'This is a private 1:1 lesson — it will not be recorded.'}<br><br>
        You'll receive a reminder email on the morning of your lesson. If you need to reschedule, reply to this email or message your tutor in the Seeds portal.
      </p>
    </div>
    <div class="footer">Seeds Tuition Ltd · seedstuition.co.uk · If you have questions, reply to this email.</div>
  </div>
</body>
</html>`;

  const transporter = getMailTransport();
  await transporter.sendMail({
    from: `"Seeds Tuition" <${process.env.EMAIL_FROM}>`,
    to: parentEmail,
    subject: `Confirmed: ${subject} lesson on ${dateStr}`,
    html,
    attachments: [{
      filename: 'seeds-lesson.ics',
      content: icsContent,
      contentType: 'text/calendar; method=REQUEST',
    }],
  });
}

/**
 * Send a 1-hour-before reminder.
 * Called by a scheduled job (cron or Vercel cron) — see vercel.json.
 */
async function sendLessonReminder(booking) {
  const {
    studentName, parentName, parentEmail, parentPhone,
    tutorName, subject, meetingLink, startTime,
  } = booking;

  const timeStr = new Date(startTime).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit',
  });

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, Arial, sans-serif; background: #f5f5f0; margin: 0; padding: 24px; }
    .wrap { max-width: 540px; margin: 0 auto; background: #fff; border-radius: 16px; overflow: hidden; }
    .header { background: #0D1B2A; padding: 24px 32px; }
    .header h1 { font-family: Georgia, serif; font-size: 20px; color: #fff; margin: 0; }
    .body { padding: 24px 32px; }
    h2 { font-family: Georgia, serif; font-size: 20px; color: #0D1B2A; margin: 0 0 16px; }
    .join-btn { display: block; background: #C8A15A; color: #fff; text-decoration: none; text-align: center; padding: 14px 20px; border-radius: 10px; font-weight: 700; font-size: 15px; }
    .footer { background: #F5F0E8; padding: 14px 32px; font-size: 12px; color: #A7A7A7; text-align: center; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header"><h1>Seeds</h1></div>
    <div class="body">
      <h2>⏰ You have a lesson today</h2>
      <p style="color:#4A5568;font-size:15px;margin-bottom:20px">
        <strong>${studentName}</strong>'s ${subject} lesson with <strong>${tutorName}</strong> is today at <strong>${timeStr}</strong>.
      </p>
      <a href="${meetingLink}" class="join-btn">Join lesson →</a>
    </div>
    <div class="footer">Seeds Tuition · seedstuition.co.uk</div>
  </div>
</body>
</html>`;

  const transporter = getMailTransport();
  await transporter.sendMail({
    from: `"Seeds Tuition" <${process.env.EMAIL_FROM}>`,
    to: parentEmail,
    subject: `⏰ Reminder: ${subject} lesson today at ${timeStr}`,
    html,
  });

  // ── SMS (if Twilio is configured) ─────────
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && parentPhone) {
    try {
      const twilio = require('twilio')(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN
      );
      await twilio.messages.create({
        body: `Seeds: ${studentName}'s ${subject} lesson with ${tutorName} starts in 1 hour (${timeStr}). Join: ${meetingLink}`,
        from: process.env.TWILIO_FROM_NUMBER,
        to: parentPhone,
      });
    } catch (err) {
      // SMS failure doesn't block email — just log it
      console.error('SMS reminder failed:', err.message);
    }
  }
}

module.exports = { sendBookingConfirmation, sendLessonReminder };
