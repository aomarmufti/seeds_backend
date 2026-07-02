// api/leads.js — GET /api/leads, POST /api/leads, PATCH /api/leads
const { applyCors } = require('../lib/cors');
const { dbGet, dbPost, supabaseRequest } = require('../lib/db');

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  // GET — fetch all leads, optional ?status= filter
  if (req.method === 'GET') {
    const { status } = req.query;
    let path = '/leads?order=created_at.desc';
    if (status) path += `&status=eq.${status}`;
    try {
      return res.status(200).json(await dbGet(path));
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST — create a new lead from journey form
  if (req.method === 'POST') {
    const { name, email, subject, level, goal, availability } = req.body || {};
    if (!name || !email || !subject || !level) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    try {
      const lead = await dbPost('/leads', {
        name, email, subject, level,
        goal: goal || null,
        availability: availability || [],
        status: 'new',
      });
      return res.status(201).json({ success: true, lead });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // PATCH — update lead status / assign tutor
  if (req.method === 'PATCH') {
    const { id, status, assignedTutor, notes } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Missing lead id' });
    const updates = {};
    if (status)        updates.status = status;
    if (assignedTutor) updates.assigned_tutor = assignedTutor;
    if (notes)         updates.notes = notes;
    try {
      const r = await supabaseRequest(
        `/leads?id=eq.${id}`,
        { method: 'PATCH', prefer: 'return=representation', body: JSON.stringify(updates) }
      );
      const data = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(data));
      return res.status(200).json({ success: true, lead: data[0] });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};
