// lib/calendar.js
// ─────────────────────────────────────────────
// Generates .ics calendar invites that work in
// Apple Calendar, Google Calendar, and Outlook.
// Hand-rolled — no external dependency. The
// ical-generator package is ESM-only and breaks
// Vercel's CommonJS serverless bundling.
// ─────────────────────────────────────────────

// Format a JS Date as UTC in the ICS "basic" format: YYYYMMDDTHHMMSSZ
function toICSDate(date) {
  return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

// Escape text per RFC 5545: backslash, semicolon, comma, then newlines
function escapeICSText(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

// Fold lines longer than 75 octets per RFC 5545 (simple char-based fold)
function foldLine(line) {
  if (line.length <= 75) return line;
  let result = '';
  let remaining = line;
  let first = true;
  while (remaining.length > 0) {
    const chunkSize = first ? 75 : 74; // continuation lines are prefixed with a space
    result += (first ? '' : '\r\n ') + remaining.slice(0, chunkSize);
    remaining = remaining.slice(chunkSize);
    first = false;
  }
  return result;
}

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}@seedstuition.co.uk`;
}

/**
 * Generate a .ics invite buffer for a booked lesson.
 *
 * @param {Object} lesson
 * @param {string} lesson.studentName
 * @param {string} lesson.tutorName
 * @param {string} lesson.subject
 * @param {string} lesson.lessonType   — 'gcse' | 'alevel' | 'group' | 'trial'
 * @param {Date}   lesson.startTime    — JS Date object (London time)
 * @param {number} lesson.durationMins
 * @param {string} lesson.meetingLink  — Google Meet / Zoom URL
 * @param {string} lesson.studentEmail
 * @returns {string} ICS file content as string
 */
function generateICS(lesson) {
  const {
    studentName, tutorName, subject, lessonType,
    startTime, durationMins, meetingLink, studentEmail,
  } = lesson;

  const endTime = new Date(startTime.getTime() + durationMins * 60 * 1000);

  const isGroup = lessonType === 'group';
  const title = isGroup
    ? `Seeds — ${subject} Group Past-Paper Session`
    : `Seeds — ${subject} with ${tutorName}`;

  const description = isGroup
    ? [
        `Group past-paper session — ${subject}`,
        `Tutor: ${tutorName}`,
        ``,
        `Join here: ${meetingLink}`,
        ``,
        `This session will be recorded and available in your Seeds portal.`,
        ``,
        `Seeds Tuition — seedstuition.co.uk`,
      ].join('\n')
    : [
        `1:1 lesson — ${subject}`,
        `Tutor: ${tutorName}`,
        `Student: ${studentName}`,
        ``,
        `Join here: ${meetingLink}`,
        ``,
        `Seeds Tuition — seedstuition.co.uk`,
      ].join('\n');

  const organizerEmail = process.env.EMAIL_FROM || 'lessons@seedstuition.co.uk';

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Seeds Tuition//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid()}`,
    `DTSTAMP:${toICSDate(new Date())}`,
    `DTSTART:${toICSDate(startTime)}`,
    `DTEND:${toICSDate(endTime)}`,
    `SUMMARY:${escapeICSText(title)}`,
    `DESCRIPTION:${escapeICSText(description)}`,
    `LOCATION:${escapeICSText(meetingLink)}`,
    `URL:${escapeICSText(meetingLink)}`,
    `ORGANIZER;CN=Seeds Tuition:mailto:${organizerEmail}`,
  ];

  if (studentEmail) {
    lines.push(
      `ATTENDEE;CN=${escapeICSText(studentName)};ROLE=REQ-PARTICIPANT:mailto:${studentEmail}`
    );
  }

  lines.push('STATUS:CONFIRMED', 'SEQUENCE:0', 'END:VEVENT', 'END:VCALENDAR');

  return lines.map(foldLine).join('\r\n');
}

module.exports = { generateICS };
