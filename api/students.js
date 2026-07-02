// api/students.js — GET /api/students
const { applyCors } = require('../lib/cors');
const { dbGet } = require('../lib/db');

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const data = await dbGet(
      '/students?select=*,bookings(id,lesson_type,start_time,tutor_name,status)&order=created_at.desc'
    );
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
