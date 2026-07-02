// api/payouts.js — GET /api/payouts, POST /api/payouts
const { applyCors } = require('../lib/cors');
const { dbGet, dbPost } = require('../lib/db');

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  if (req.method === 'GET') {
    const { tutor } = req.query;
    let path = '/payouts?order=requested_at.desc';
    if (tutor) path += `&tutor_name=eq.${encodeURIComponent(tutor)}`;
    try {
      const data = await dbGet(path);
      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    const { tutorName, amountPence } = req.body || {};
    if (!tutorName || !amountPence || amountPence < 5000) {
      return res.status(400).json({ error: 'Minimum payout £50' });
    }
    try {
      const payout = await dbPost('/payouts', {
        tutor_name: tutorName,
        amount_pence: amountPence,
        status: 'requested',
      });
      return res.status(201).json({ success: true, payout });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};
