// api/enrolments.js — GET, POST, PATCH /api/enrolments
// Handles CRUD operations for student enrolments (multi-subject/multi-tutor support)
// Routes: GET /api/enrolments?student_id=...&tutor_id=...&status=...
//         POST /api/enrolments (create new enrolment)
//         PATCH /api/enrolments (update enrolment by id in body)

const { applyCors } = require('../lib/cors');
const { dbGet, dbPost, dbPatch } = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { isValidId } = require('../lib/validate');

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  // GET — fetch enrolments
  // Scoped by caller: admin sees everything, tutors see their own, students see their own
  if (req.method === 'GET') {
    const caller = await requireAuth(req, res);
    if (!caller) return;

    const { student_id, tutor_id, status } = req.query;
    let path = '/enrolments?order=created_at.desc';

    try {
      if (caller.role === 'admin') {
        // Admin can filter by any combination
        if (student_id) path += `&student_id=eq.${student_id}`;
        if (tutor_id) path += `&tutor_id=eq.${tutor_id}`;
        if (status) path += `&status=eq.${status}`;
      } else if (caller.role === 'tutor') {
        // Tutors see only their own enrolments
        const profile = await dbGet(`/profiles?id=eq.${caller.id}&select=tutor_id&limit=1`);
        const myTutorId = profile[0]?.tutor_id;
        if (!myTutorId) return res.status(403).json({ error: 'Tutor account not set up' });
        path += `&tutor_id=eq.${myTutorId}`;
        if (student_id) path += `&student_id=eq.${student_id}`;
      } else if (caller.role === 'student') {
        // Students see only their own enrolments
        // Look up their student record by parent_email
        const student = await dbGet(`/students?parent_email=eq.${encodeURIComponent(caller.email)}&select=id&limit=1`);
        const myStudentId = student[0]?.id;
        if (!myStudentId) return res.status(403).json({ error: 'Student account not set up' });
        path += `&student_id=eq.${myStudentId}`;
      } else {
        return res.status(403).json({ error: 'Unauthorized role' });
      }

      return res.status(200).json(await dbGet(path));
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST — create a new enrolment
  // Admin/system only: creates an enrolment for a student
  if (req.method === 'POST') {
    const caller = await requireAuth(req, res);
    if (!caller) return;

    if (caller.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can create enrolments' });
    }

    const { student_id, subject, level, tutor_id, status, rate_pence } = req.body;

    // Validate required fields
    if (!student_id || !subject || !level) {
      return res.status(400).json({ error: 'student_id, subject, and level are required' });
    }

    // Validate level
    if (!['GCSE', 'A-Level', 'KS3'].includes(level)) {
      return res.status(400).json({ error: 'level must be GCSE, A-Level, or KS3' });
    }

    // Validate status if provided
    const enrolmentStatus = status || 'pending';
    if (!['pending', 'active', 'paused', 'ended'].includes(enrolmentStatus)) {
      return res.status(400).json({ error: 'status must be pending, active, paused, or ended' });
    }

    // Default rate based on level if not provided
    const defaultRate = level === 'A-Level' ? 4500 : 4000;
    const finalRate = rate_pence !== undefined ? rate_pence : defaultRate;

    try {
      // Verify student exists
      const student = await dbGet(`/students?id=eq.${student_id}&limit=1`);
      if (!student.length) {
        return res.status(404).json({ error: 'Student not found' });
      }

      // Verify tutor exists if provided
      if (tutor_id) {
        const tutor = await dbGet(`/tutors?id=eq.${tutor_id}&limit=1`);
        if (!tutor.length) {
          return res.status(404).json({ error: 'Tutor not found' });
        }
      }

      const enrolment = await dbPost('/enrolments', {
        student_id,
        subject,
        level,
        tutor_id: tutor_id || null,
        status: enrolmentStatus,
        rate_pence: finalRate,
      });

      return res.status(201).json(enrolment);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // PATCH — update an enrolment
  // Admin can update: status, tutor_id, rate_pence
  // Tutors can: flag for reassignment (setting a specific status)
  if (req.method === 'PATCH') {
    const caller = await requireAuth(req, res);
    if (!caller) return;

    const { id, status, tutor_id, rate_pence, ended_at } = req.body;

    if (!id) {
      return res.status(400).json({ error: 'id is required' });
    }

    if (!isValidId(id)) {
      return res.status(400).json({ error: 'Invalid enrolment id' });
    }

    try {
      // Get the enrolment to check permissions
      const enrolment = await dbGet(`/enrolments?id=eq.${id}&limit=1`);
      if (!enrolment.length) {
        return res.status(404).json({ error: 'Enrolment not found' });
      }

      const current = enrolment[0];

      // Permission check
      if (caller.role === 'tutor') {
        // Tutors can only read their own enrolments, not modify them
        return res.status(403).json({ error: 'Tutors cannot directly modify enrolments' });
      } else if (caller.role === 'student') {
        // Students can only pause/end their own enrolments
        const student = await dbGet(`/students?parent_email=eq.${encodeURIComponent(caller.email)}&select=id&limit=1`);
        const myStudentId = student[0]?.id;
        if (current.student_id !== myStudentId) {
          return res.status(403).json({ error: 'Cannot modify another student\'s enrolment' });
        }
        // Students can only change status to 'paused' or 'ended'
        if (status && !['paused', 'ended'].includes(status)) {
          return res.status(400).json({ error: 'Students can only pause or end enrolments' });
        }
      } else if (caller.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
      }

      // Build update object
      const update = {};
      if (status !== undefined) update.status = status;
      if (tutor_id !== undefined) update.tutor_id = tutor_id;
      if (rate_pence !== undefined) update.rate_pence = rate_pence;
      if (ended_at !== undefined) update.ended_at = ended_at;

      // Validate level if changing it via status
      if (status && !['pending', 'active', 'paused', 'ended'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }

      // If ending an enrolment, set ended_at automatically if not provided
      if (status === 'ended' && !ended_at) {
        update.ended_at = new Date().toISOString();
      }

      if (Object.keys(update).length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      const updated = await dbPatch(`/enrolments?id=eq.${id}`, update);

      return res.status(200).json(updated);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Method not allowed
  return res.status(405).json({ error: 'Method not allowed' });
};
