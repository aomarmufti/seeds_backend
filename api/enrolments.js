// api/enrolments.js — GET, POST, PATCH /api/enrolments
// Handles CRUD operations for student enrolments (multi-subject/multi-tutor support)
// Routes: GET /api/enrolments?student_id=...&tutor_id=...&status=...
//         POST /api/enrolments (create new enrolment)
//         PATCH /api/enrolments (update enrolment by id in body)

const { applyCors } = require('../lib/cors');
const { dbGet, dbPost, dbPatch } = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { isValidId, normalizeEmail } = require('../lib/validate');

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
        const student = await dbGet(`/students?parent_email=eq.${encodeURIComponent(normalizeEmail(caller.email))}&select=id&limit=1`);
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

    const { subject, level, tutor_id, status, rate_pence } = req.body;
    let { student_id } = req.body;

    // A family asking to study another subject is the one creation a student
    // may make, and it is a request rather than an arrangement: it lands as
    // 'pending' with no tutor and no negotiated rate, for admin to place.
    //
    // The design rule is that the student asks, the tutor teaches, and the
    // admin decides. A family choosing its own tutor or its own price sounds
    // friendly and quietly destroys capacity planning and margin, so those
    // stay admin's — a family that sends them is told no rather than ignored.
    const isRequest = caller.role === 'student';
    if (!isRequest && caller.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can create enrolments' });
    }
    if (isRequest) {
      if (tutor_id !== undefined || rate_pence !== undefined || (status && status !== 'pending')) {
        return res.status(403).json({
          error: 'A subject request can\'t set its own tutor, rate or status — we\'ll arrange those and confirm.',
        });
      }
      const own = await dbGet(`/students?parent_email=eq.${encodeURIComponent(normalizeEmail(caller.email))}&select=id&limit=1`);
      if (!own.length) return res.status(403).json({ error: 'Student account not set up' });
      // Ignore any student_id on the body — a family requests for itself.
      student_id = own[0].id;
    }

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
        // Students can only pause/end their own enrolments. normalizeEmail
        // because the stored parent_email is normalised and an exact match on
        // a differently-cased login would silently fail this check.
        const student = await dbGet(`/students?parent_email=eq.${encodeURIComponent(normalizeEmail(caller.email))}&select=id&limit=1`);
        const myStudentId = student[0]?.id;
        if (!myStudentId || current.student_id !== myStudentId) {
          return res.status(403).json({ error: 'Cannot modify another student\'s enrolment' });
        }
        // Students can only change status to 'paused' or 'ended'
        if (status && !['paused', 'ended'].includes(status)) {
          return res.status(400).json({ error: 'Students can only pause or end enrolments' });
        }
      } else if (caller.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
      }

      // What a caller may write, not merely what they may reach. The role
      // check above validated `status` for a student and then every field on
      // the body was applied regardless of who sent it — so a family could
      // PATCH their own enrolment with rate_pence: 1, or hand themselves any
      // tutor_id, and it would be written. Omitting `status` skipped the only
      // check that existed. Rate and tutor are commercial facts and are
      // admin's alone; a family may pause or end, and nothing else.
      const WRITABLE = caller.role === 'admin'
        ? ['status', 'tutor_id', 'rate_pence', 'ended_at']
        : ['status'];

      const requested = { status, tutor_id, rate_pence, ended_at };
      const refused = Object.keys(requested)
        .filter((k) => requested[k] !== undefined && !WRITABLE.includes(k));
      if (refused.length) {
        return res.status(403).json({
          error: `Only an admin can change ${refused.join(' and ')} on an enrolment.`,
        });
      }

      const update = {};
      for (const field of WRITABLE) {
        if (requested[field] !== undefined) update[field] = requested[field];
      }

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
