const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateICS } = require('../lib/calendar');

function baseLesson(overrides = {}) {
  return {
    studentName: 'Test Student',
    tutorName: 'Azeem',
    subject: 'Maths',
    lessonType: 'gcse',
    startTime: new Date('2026-09-01T10:00:00Z'),
    durationMins: 55,
    meetingLink: 'https://meet.google.com/seeds-tuition',
    studentEmail: 'student@example.com',
    ...overrides,
  };
}

test('generates a well-formed VEVENT with correct start/end times', () => {
  const ics = generateICS(baseLesson());
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /BEGIN:VEVENT/);
  assert.match(ics, /DTSTART:20260901T100000Z/);
  assert.match(ics, /DTEND:20260901T105500Z/); // 55 mins later
  assert.match(ics, /END:VEVENT/);
  assert.match(ics, /END:VCALENDAR/);
});

test('includes an ATTENDEE line only when studentEmail is provided', () => {
  const withEmail = generateICS(baseLesson());
  assert.match(withEmail, /ATTENDEE/);

  const withoutEmail = generateICS(baseLesson({ studentEmail: '' }));
  assert.doesNotMatch(withoutEmail, /ATTENDEE/);
});

test('escapes RFC 5545 special characters in free-text fields', () => {
  const ics = generateICS(baseLesson({ subject: 'Maths, Physics; Chemistry\nExtra' }));
  // Raw unescaped separators must not appear in the folded SUMMARY/DESCRIPTION line
  assert.match(ics, /Maths\\, Physics\\; Chemistry\\nExtra/);
});

test('folds lines longer than 75 octets per RFC 5545', () => {
  const longSubject = 'A'.repeat(200);
  const ics = generateICS(baseLesson({ subject: longSubject }));
  const lines = ics.split('\r\n');
  for (const line of lines) {
    // continuation lines start with a space and are allowed to be up to 74 + 1
    assert.ok(line.length <= 75 || line.startsWith(' '), `line exceeds fold width: ${line.slice(0, 20)}...`);
  }
});

test('group sessions use group-specific title and description', () => {
  const ics = generateICS(baseLesson({ lessonType: 'group', subject: 'Chemistry' }));
  assert.match(ics, /Group Past-Paper Session/);
  // The description for a 1:1 lesson names the student explicitly; group
  // sessions don't, even though the ATTENDEE field (a separate calendar
  // field, present for both types) still carries the student's name.
  assert.doesNotMatch(ics, /DESCRIPTION:[^\r\n]*Student:/);
});
