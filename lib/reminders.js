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

/**
 * Notify a student that their tutor has proposed lesson times to choose from.
 */
async function sendSlotProposal({ studentName, parentEmail, tutorName, subject, slots, portalUrl }) {
  const slotRows = (slots || []).map(s => {
    const d = new Date(s);
    const label = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return `<div style="background:#FAF8F4;border:1px solid #E8E8E8;border-radius:10px;padding:12px 16px;margin-bottom:8px;font-size:14px;color:#0D1B2A;font-weight:600">📅 ${label} at ${time}</div>`;
  }).join('');

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,Arial,sans-serif;background:#f5f5f0;margin:0;padding:24px">
  <div style="max-width:540px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden">
    <div style="background:#0D1B2A;padding:28px 32px">
      <h1 style="font-family:Georgia,serif;font-size:24px;color:#fff;margin:0 0 4px">Seeds</h1>
      <p style="font-size:13px;color:rgba(255,255,255,.5);margin:0">GCSE &amp; A-Level Tuition</p>
    </div>
    <div style="padding:28px 32px">
      <div style="background:rgba(200,161,90,0.12);border:1px solid rgba(200,161,90,0.3);color:#C8A15A;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;padding:4px 10px;border-radius:20px;display:inline-block;margin-bottom:16px">Choose your time</div>
      <h2 style="font-family:Georgia,serif;font-size:22px;color:#0D1B2A;margin:0 0 12px">${tutorName} has proposed times for your ${subject} lesson</h2>
      <p style="color:#4A5568;font-size:15px;margin-bottom:20px">Hi ${studentName}, your tutor is ready to start. Log in to your Seeds portal and pick whichever of these works best — your lesson will be booked instantly:</p>
      ${slotRows}
      <a href="${portalUrl || 'http://localhost:8080/seeds-full-platform.html'}" style="display:block;background:#0D1B2A;color:#fff;text-decoration:none;text-align:center;padding:14px 20px;border-radius:10px;font-weight:700;font-size:15px;margin:20px 0 16px">Pick your time in the portal →</a>
      <p style="font-size:12px;color:#A7A7A7;line-height:1.6">Once you choose, you'll get a confirmation email with a calendar invite and the meeting link.</p>
    </div>
    <div style="background:#F5F0E8;padding:16px 32px;font-size:12px;color:#A7A7A7;text-align:center">Seeds Tuition · seedstuition.co.uk</div>
  </div>
</body>
</html>`;

  const transporter = getMailTransport();
  await transporter.sendMail({
    from: `"Seeds Tuition" <${process.env.EMAIL_FROM}>`,
    to: parentEmail,
    subject: `${tutorName} has proposed times for your ${subject} lesson`,
    html,
  });
}

module.exports = { sendBookingConfirmation, sendLessonReminder, sendSlotProposal };

// ─────────────────────────────────────────────────────────────────────────────
// ADDITIONAL NOTIFICATION EMAILS
// ─────────────────────────────────────────────────────────────────────────────

const BRAND_HEADER = `
<div style="background:#0D1B2A;padding:24px 28px">
  <h1 style="font-family:Georgia,serif;color:#fff;margin:0;font-size:22px">Seeds</h1>
  <p style="font-size:12px;color:rgba(255,255,255,.4);margin:4px 0 0">GCSE &amp; A-Level Tuition</p>
</div>`;

const BRAND_FOOTER = `
<div style="background:#F5F0E8;padding:14px 28px;font-size:11px;color:#A7A7A7;text-align:center">
  Seeds Tuition · seedstuition.co.uk · Unsubscribe preferences in your portal
</div>`;

/**
 * 1. Journey form submitted — confirm to parent immediately.
 */
async function sendEnquiryConfirmation({ name, email, subject, level, goal }) {
  const transporter = getMailTransport();
  await transporter.sendMail({
    from: `"Seeds Tuition" <${process.env.EMAIL_FROM}>`,
    to: email,
    subject: `We've received your Seeds enquiry — ${subject}`,
    html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f5f5f0;margin:0;padding:20px">
      <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden">
        ${BRAND_HEADER}
        <div style="padding:24px 28px">
          <h2 style="font-family:Georgia,serif;color:#0D1B2A;margin-bottom:8px">Thanks, ${name.split(' ')[0]}!</h2>
          <p style="color:#4A5568;font-size:15px;line-height:1.6">We've received your enquiry for <strong>${subject} (${level})</strong>. Our team will review it and be in touch within 24 hours to match you with the right tutor.</p>
          <div style="background:#FAF8F4;border-radius:10px;padding:14px 16px;margin:16px 0">
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:14px"><span style="color:#718096">Subject</span><span style="font-weight:600">${subject}</span></div>
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:14px"><span style="color:#718096">Level</span><span style="font-weight:600">${level}</span></div>
            ${goal ? `<div style="display:flex;justify-content:space-between;font-size:14px"><span style="color:#718096">Goal</span><span style="font-weight:600">${goal}</span></div>` : ''}
          </div>
          <p style="color:#4A5568;font-size:14px;line-height:1.6">While you wait, feel free to explore our <a href="https://seedstuition.co.uk" style="color:#C8A15A">website</a> to learn more about our tutors and approach.</p>
          <p style="color:#718096;font-size:13px;margin-top:20px">JazakAllah khayran for choosing Seeds. We look forward to supporting your learning journey.</p>
        </div>
        ${BRAND_FOOTER}
      </div>
    </body></html>`,
  });
}

/**
 * 2. Tutor notified when admin assigns a lead to them.
 */
async function sendTutorAssigned({ tutorEmail, tutorName, studentName, subject, level, goal, availability }) {
  const transporter = getMailTransport();
  await transporter.sendMail({
    from: `"Seeds Tuition" <${process.env.EMAIL_FROM}>`,
    to: tutorEmail,
    subject: `New student assigned — ${studentName} (${subject})`,
    html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f5f5f0;margin:0;padding:20px">
      <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden">
        ${BRAND_HEADER}
        <div style="padding:24px 28px">
          <div style="background:rgba(200,161,90,0.12);border:1px solid rgba(200,161,90,0.3);color:#C8A15A;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;padding:4px 10px;border-radius:20px;display:inline-block;margin-bottom:14px">New assignment</div>
          <h2 style="font-family:Georgia,serif;color:#0D1B2A;margin-bottom:8px">Hi ${tutorName.split(' ')[0]}, you have a new student</h2>
          <p style="color:#4A5568;font-size:15px;line-height:1.6">Admin has assigned <strong>${studentName}</strong> to you. Please log in to your portal to propose available lesson times.</p>
          <div style="background:#FAF8F4;border-radius:10px;padding:14px 16px;margin:16px 0">
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:14px"><span style="color:#718096">Student</span><span style="font-weight:600">${studentName}</span></div>
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:14px"><span style="color:#718096">Subject</span><span style="font-weight:600">${subject}</span></div>
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:14px"><span style="color:#718096">Level</span><span style="font-weight:600">${level}</span></div>
            ${goal ? `<div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:14px"><span style="color:#718096">Goal</span><span style="font-weight:600">${goal}</span></div>` : ''}
            ${availability ? `<div style="display:flex;justify-content:space-between;font-size:14px"><span style="color:#718096">Availability</span><span style="font-weight:600">${Array.isArray(availability)?availability.join(', '):availability}</span></div>` : ''}
          </div>
          <p style="font-size:13px;color:#718096">Log in → My Schedule → the student will appear under "New trial requests" where you can propose times.</p>
        </div>
        ${BRAND_FOOTER}
      </div>
    </body></html>`,
  });
}

/**
 * 3. Tutor notified when student picks a slot (booking confirmed).
 */
async function sendSlotBookedToTutor({ tutorEmail, tutorName, studentName, subject, startTime, meetingLink }) {
  const transporter = getMailTransport();
  const d = new Date(startTime).toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', hour:'2-digit', minute:'2-digit' });
  await transporter.sendMail({
    from: `"Seeds Tuition" <${process.env.EMAIL_FROM}>`,
    to: tutorEmail,
    subject: `Lesson booked — ${studentName} on ${d}`,
    html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f5f5f0;margin:0;padding:20px">
      <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden">
        ${BRAND_HEADER}
        <div style="padding:24px 28px">
          <div style="background:rgba(45,122,79,0.1);border:1px solid rgba(45,122,79,0.3);color:#2D7A4F;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;padding:4px 10px;border-radius:20px;display:inline-block;margin-bottom:14px">✓ Lesson confirmed</div>
          <h2 style="font-family:Georgia,serif;color:#0D1B2A;margin-bottom:8px">${studentName} has booked a lesson</h2>
          <div style="background:#FAF8F4;border-radius:10px;padding:14px 16px;margin:16px 0">
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:14px"><span style="color:#718096">Student</span><span style="font-weight:600">${studentName}</span></div>
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:14px"><span style="color:#718096">Subject</span><span style="font-weight:600">${subject}</span></div>
            <div style="display:flex;justify-content:space-between;font-size:14px"><span style="color:#718096">When</span><span style="font-weight:600">${d}</span></div>
          </div>
          ${meetingLink ? `<a href="${meetingLink}" style="display:block;background:#0D1B2A;color:#fff;text-decoration:none;text-align:center;padding:12px;border-radius:10px;font-weight:700;font-size:15px;margin-bottom:12px">Join lesson →</a>` : ''}
        </div>
        ${BRAND_FOOTER}
      </div>
    </body></html>`,
  });
}

/**
 * 4. Tutor notified when payout is sent.
 */
async function sendPayoutNotification({ tutorEmail, tutorName, amountPence, transferId, isAutomatic }) {
  const transporter = getMailTransport();
  const amount = `£${(amountPence / 100).toFixed(2)}`;
  await transporter.sendMail({
    from: `"Seeds Tuition" <${process.env.EMAIL_FROM}>`,
    to: tutorEmail,
    subject: `${amount} has been transferred to your bank account`,
    html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f5f5f0;margin:0;padding:20px">
      <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden">
        ${BRAND_HEADER}
        <div style="padding:24px 28px;text-align:center">
          <div style="font-size:3rem;margin-bottom:8px">💸</div>
          <h2 style="font-family:Georgia,serif;color:#0D1B2A;margin-bottom:4px">Payment sent</h2>
          <div style="font-size:2rem;font-weight:700;color:#2D7A4F;margin:12px 0">${amount}</div>
          <p style="color:#4A5568;font-size:14px">Hi ${tutorName.split(' ')[0]}, your ${isAutomatic ? 'weekly ' : ''}earnings have been transferred to your bank account via Stripe.</p>
          ${transferId ? `<div style="background:#FAF8F4;border-radius:8px;padding:10px 14px;font-size:12px;color:#718096;margin-top:12px">Transfer ID: ${transferId}</div>` : ''}
          <p style="color:#A7A7A7;font-size:12px;margin-top:16px">Funds typically arrive within 1–2 business days. View your earnings history in your Seeds portal.</p>
        </div>
        ${BRAND_FOOTER}
      </div>
    </body></html>`,
  });
}

/**
 * 5. Notify recipient when they receive a message.
 */
async function sendMessageNotification({ recipientEmail, recipientName, senderName, senderRole, preview, portalUrl }) {
  const transporter = getMailTransport();
  const roleLabel = senderRole === 'tutor' ? 'tutor' : senderRole === 'admin' ? 'Seeds admin' : 'student';
  await transporter.sendMail({
    from: `"Seeds Tuition" <${process.env.EMAIL_FROM}>`,
    to: recipientEmail,
    subject: `New message from ${senderName} on Seeds`,
    html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f5f5f0;margin:0;padding:20px">
      <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden">
        ${BRAND_HEADER}
        <div style="padding:24px 28px">
          <h2 style="font-family:Georgia,serif;color:#0D1B2A;margin-bottom:8px">You have a new message</h2>
          <p style="color:#4A5568;font-size:14px">Your ${roleLabel} <strong>${senderName}</strong> sent you a message on Seeds:</p>
          <div style="background:#FAF8F4;border-left:4px solid #C8A15A;padding:12px 16px;margin:16px 0;border-radius:0 8px 8px 0;font-size:14px;color:#0D1B2A;font-style:italic">"${preview.slice(0, 200)}${preview.length > 200 ? '…' : ''}"</div>
          <a href="${portalUrl || 'http://localhost:8080/seeds-full-platform.html'}" style="display:block;background:#0D1B2A;color:#fff;text-decoration:none;text-align:center;padding:12px;border-radius:10px;font-weight:700;font-size:15px">Reply in portal →</a>
        </div>
        ${BRAND_FOOTER}
      </div>
    </body></html>`,
  });
}

/**
 * 6. Admin alert when a new enquiry arrives.
 */
async function sendAdminEnquiryAlert({ adminEmail, studentName, subject, level, goal, studentEmail }) {
  const transporter = getMailTransport();
  await transporter.sendMail({
    from: `"Seeds Tuition" <${process.env.EMAIL_FROM}>`,
    to: adminEmail,
    subject: `🌱 New enquiry: ${studentName} — ${subject}`,
    html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f5f5f0;margin:0;padding:20px">
      <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden">
        ${BRAND_HEADER}
        <div style="padding:24px 28px">
          <h2 style="font-family:Georgia,serif;color:#0D1B2A;margin-bottom:8px">New enquiry received</h2>
          <div style="background:#FAF8F4;border-radius:10px;padding:14px 16px;margin:16px 0">
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:14px"><span style="color:#718096">Name</span><span style="font-weight:600">${studentName}</span></div>
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:14px"><span style="color:#718096">Email</span><span style="font-weight:600">${studentEmail}</span></div>
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:14px"><span style="color:#718096">Subject</span><span style="font-weight:600">${subject}</span></div>
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:14px"><span style="color:#718096">Level</span><span style="font-weight:600">${level}</span></div>
            ${goal ? `<div style="display:flex;justify-content:space-between;font-size:14px"><span style="color:#718096">Goal</span><span style="font-weight:600">${goal}</span></div>` : ''}
          </div>
          <p style="font-size:13px;color:#718096">Log in to your Seeds admin panel to assign a tutor and respond.</p>
        </div>
        ${BRAND_FOOTER}
      </div>
    </body></html>`,
  });
}

module.exports = {
  sendBookingConfirmation, sendLessonReminder, sendSlotProposal,
  sendEnquiryConfirmation, sendTutorAssigned, sendSlotBookedToTutor,
  sendPayoutNotification, sendMessageNotification, sendAdminEnquiryAlert,
};
