// api/leads.js — GET, POST, PATCH /api/leads
// Also handles action=select-slot to convert a proposed slot into a real booking
const { applyCors } = require('../lib/cors');
const { dbGet, dbPost, supabaseRequest } = require('../lib/db');
const { resolvePrice } = require('../lib/pricing');

function getMeetingLink(tutorName) {
  const links = {
    'Azeem': process.env.MEET_LINK_AZEEM,
    'Azeem Omar-Mufti': process.env.MEET_LINK_AZEEM,
    'Suleiman': process.env.MEET_LINK_SULEIMAN,
    'Abdul-Moez': process.env.MEET_LINK_ABDULMOEZ,
  };
  return links[tutorName] || 'https://meet.google.com/seeds-tuition';
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  // GET — fetch all leads, optional ?status= or ?email=
  if (req.method === 'GET') {
    const { status, email } = req.query;
    let path = '/leads?order=created_at.desc';
    if (status) path += `&status=eq.${status}`;
    if (email)  path += `&email=eq.${encodeURIComponent(email)}`;
    try {
      return res.status(200).json(await dbGet(path));
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST — create a new lead OR select a slot (action-based)
  if (req.method === 'POST') {
    const { action } = req.body || {};

    // ── SELECT SLOT → create booking ──────────────────────────────────
    if (action === 'select-slot') {
      const { leadId, chosenSlot } = req.body;
      if (!leadId || !chosenSlot) return res.status(400).json({ error: 'leadId and chosenSlot required' });
      try {
        // Fetch the lead
        const leads = await dbGet(`/leads?id=eq.${leadId}&limit=1`);
        if (!leads.length) return res.status(404).json({ error: 'Lead not found' });
        const lead = leads[0];

        // Parse tutor from notes
        let tutorName = lead.assigned_tutor;
        try {
          const notes = JSON.parse(lead.notes || '{}');
          if (notes.tutorName) tutorName = notes.tutorName;
        } catch(e) {}

        const pricing = resolvePrice('trial', lead.level);
        const meetingLink = getMeetingLink(tutorName);

        // Upsert student
        let student;
        const existing = await dbGet(`/students?parent_email=eq.${encodeURIComponent(lead.email)}&limit=1`);
        if (existing.length) {
          student = existing[0];
        } else {
          student = await dbPost('/students', {
            parent_name: lead.name,
            parent_email: lead.email,
            student_name: lead.name,
          });
        }

        // Create booking
        const booking = await dbPost('/bookings', {
          student_id: student.id,
          tutor_name: tutorName,
          subject: lead.subject,
          lesson_type: 'trial',
          start_time: chosenSlot,
          duration_mins: pricing.duration,
          fee_pence: 0,
          status: 'confirmed',
          meet_link: meetingLink,
        });

        // Mark lead as booked
        await supabaseRequest(`/leads?id=eq.${leadId}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ status: 'booked' }),
        });

        // Send confirmation email (best-effort)
        try {
          const { sendBookingConfirmation } = require('../lib/reminders');
          await sendBookingConfirmation({
            studentName: lead.name,
            parentName: lead.name,
            parentEmail: lead.email,
            tutorName, subject: lead.subject,
            lessonType: 'trial', studentLevel: lead.level,
            startTime: chosenSlot, durationMins: pricing.duration,
            meetingLink, amountPence: 0,
          });
        } catch(e) { console.warn('Email failed:', e.message); }

        return res.status(201).json({ success: true, booking, meetingLink });
      } catch(e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // ── Normal lead creation ──────────────────────────────────────────
    const { name, email, subject, level, goal, availability } = req.body;
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

  // PATCH — update lead status / assign tutor / save proposed slots
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
      const lead = data[0];

      // If proposed slots were saved, email the student to go pick one
      if (notes) {
        try {
          const parsed = JSON.parse(notes);
          if (parsed.proposedSlots && parsed.proposedSlots.length && lead && lead.email) {
            const { sendSlotProposal } = require('../lib/reminders');
            await sendSlotProposal({
              studentName: lead.name,
              parentEmail: lead.email,
              tutorName: parsed.tutorName || lead.assigned_tutor || 'Your tutor',
              subject: lead.subject,
              slots: parsed.proposedSlots,
              portalUrl: req.body.portalUrl || null,
            });
          }
        } catch(e) { console.warn('Slot proposal email failed:', e.message); }
      }

      return res.status(200).json({ success: true, lead });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};
