// api/lifecycle.js — CRUD for lesson_notes, homework, progress, messages
// Routes by ?resource= and HTTP method
const { applyCors } = require('../lib/cors');
const { dbGet, dbPost, supabaseRequest } = require('../lib/db');

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  const resource = req.query.resource;

  // ── LESSONS — tutor creates a booking directly ────────────────────────
  if (resource === 'lessons') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const b = req.body || {};
    if (!b.studentId || !b.tutorName || !b.startTime) {
      return res.status(400).json({ error: 'studentId, tutorName, startTime required' });
    }
    try {
      const links = {
        'Azeem Omar-Mufti': process.env.MEET_LINK_AZEEM,
        'Suleiman': process.env.MEET_LINK_SULEIMAN,
        'Abdul-Moez': process.env.MEET_LINK_ABDULMOEZ,
      };
      const feeMap = { gcse: 4000, alevel: 4500, group: 2000, trial: 0 };
      const lessonType = b.lessonType || 'gcse';
      const created = [];
      const weeks = b.recurringWeeks && b.recurringWeeks > 1 ? b.recurringWeeks : 1;
      const start = new Date(b.startTime);
      for (let i = 0; i < weeks; i++) {
        const slot = new Date(start.getTime() + i * 7 * 24 * 60 * 60 * 1000);
        const booking = await dbPost('/bookings', {
          student_id: b.studentId,
          tutor_name: b.tutorName,
          subject: b.subject || null,
          lesson_type: lessonType,
          start_time: slot.toISOString(),
          duration_mins: b.durationMins || 55,
          fee_pence: feeMap[lessonType] ?? 4000,
          status: 'confirmed',
          meet_link: links[b.tutorName] || 'https://meet.google.com/seeds-tuition',
        });
        created.push(booking);
      }
      return res.status(201).json({ success: true, created: created.length, bookings: created });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  const validResources = ['notes', 'homework', 'progress', 'messages'];
  if (!validResources.includes(resource)) {
    return res.status(400).json({ error: 'Invalid resource' });
  }

  const table = resource === 'notes' ? 'lesson_notes' : resource;

  try {
    // ── GET — list by student ─────────────────────────────────────────
    if (req.method === 'GET') {
      const { studentId, studentEmail } = req.query;
      let sid = studentId;
      // Allow lookup by email (student portal doesn't know its student_id)
      if (!sid && studentEmail) {
        const students = await dbGet(`/students?parent_email=eq.${encodeURIComponent(studentEmail)}&limit=1`);
        if (!students.length) return res.status(200).json([]);
        sid = students[0].id;
      }
      if (!sid) return res.status(400).json({ error: 'studentId or studentEmail required' });

      let order = 'created_at.desc';
      if (resource === 'progress') order = 'updated_at.desc';
      const data = await dbGet(`/${table}?student_id=eq.${sid}&order=${order}`);
      return res.status(200).json(data);
    }

    // ── POST — create ─────────────────────────────────────────────────
    if (req.method === 'POST') {
      const body = req.body || {};
      let record;

      if (resource === 'notes') {
        record = {
          booking_id: body.bookingId || null,
          student_id: body.studentId,
          tutor_name: body.tutorName,
          subject: body.subject || null,
          note: body.note,
        };
      } else if (resource === 'homework') {
        record = {
          student_id: body.studentId,
          tutor_name: body.tutorName,
          subject: body.subject || null,
          title: body.title,
          description: body.description || null,
          due_date: body.dueDate || null,
        };
      } else if (resource === 'progress') {
        // Upsert progress (one row per student+subject)
        const r = await supabaseRequest(
          `/progress?on_conflict=student_id,subject`,
          {
            method: 'POST',
            prefer: 'resolution=merge-duplicates,return=representation',
            body: JSON.stringify({
              student_id: body.studentId,
              subject: body.subject,
              percent: body.percent,
              target_grade: body.targetGrade || null,
              current_grade: body.currentGrade || null,
              note: body.note || null,
              updated_at: new Date().toISOString(),
            }),
          }
        );
        const data = await r.json();
        if (!r.ok) throw new Error(JSON.stringify(data));
        return res.status(201).json({ success: true, record: data[0] });
      } else if (resource === 'messages') {
        record = {
          student_id: body.studentId,
          sender_role: body.senderRole,
          sender_name: body.senderName || null,
          body: body.body,
        };
      }

      const created = await dbPost(`/${table}`, record);
      return res.status(201).json({ success: true, record: created });
    }

    // ── PATCH — update (homework completion, message read) ────────────
    if (req.method === 'PATCH') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      const updates = {};
      if (resource === 'homework') {
        if (typeof req.body.completed === 'boolean') {
          updates.completed = req.body.completed;
          updates.completed_at = req.body.completed ? new Date().toISOString() : null;
        }
      } else if (resource === 'messages') {
        if (typeof req.body.read === 'boolean') updates.read = req.body.read;
      }
      const r = await supabaseRequest(`/${table}?id=eq.${id}`, {
        method: 'PATCH', prefer: 'return=representation',
        body: JSON.stringify(updates),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(data));
      return res.status(200).json({ success: true, record: data[0] });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
