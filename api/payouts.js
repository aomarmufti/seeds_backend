// api/payouts.js — GET /api/payouts, POST /api/payouts
const { applyCors } = require('../lib/cors');
const { dbGet, dbPost, supabaseRequest } = require('../lib/db');

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  if (req.method === 'GET') {
    const { tutor } = req.query;
    let path = '/payouts?order=requested_at.desc';
    if (tutor) path += `&tutor_name=eq.${encodeURIComponent(tutor)}`;
    try {
      return res.status(200).json(await dbGet(path));
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    const { tutorName, amountPence, markPaid } = req.body || {};

    // markPaid=true means admin is approving — mark confirmed bookings as completed
    if (markPaid) {
      try {
        await supabaseRequest(
          `/bookings?tutor_name=eq.${encodeURIComponent(tutorName)}&status=eq.confirmed&fee_pence=gt.0`,
          { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'completed' }) }
        );
        // Update any requested payouts to paid
        await supabaseRequest(
          `/payouts?tutor_name=eq.${encodeURIComponent(tutorName)}&status=eq.requested`,
          { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'paid', paid_at: new Date().toISOString() }) }
        );
        return res.status(200).json({ success: true });
      } catch(e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // Normal payout request from tutor
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
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};
