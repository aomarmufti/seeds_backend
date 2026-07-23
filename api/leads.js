// api/leads.js — GET, POST, PATCH /api/leads
// Also handles action=select-slot to convert a proposed slot into a real booking
const { applyCors } = require('../lib/cors');
const { dbGet, dbPost, supabaseRequest } = require('../lib/db');
const { resolvePrice } = require('../lib/pricing');
const { isValidId } = require('../lib/validate');
const { getMeetingLink } = require('../lib/tutors');

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
      if (!isValidId(leadId)) return res.status(400).json({ error: 'Invalid leadId' });
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
        const meetingLink = await getMeetingLink(tutorName);

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
          const { sendBookingConfirmation, sendSlotBookedToTutor } = require('../lib/reminders');
          const profiles = await dbGet(`/profiles?tutor_name=eq.${encodeURIComponent(tutorName)}&limit=1`);
          const tutorEmail = profiles[0]?.email;
          await Promise.all([
            sendBookingConfirmation({
              studentName: lead.name, parentName: lead.name, parentEmail: lead.email,
              tutorName, subject: lead.subject, lessonType: 'trial', studentLevel: lead.level,
              startTime: chosenSlot, durationMins: pricing.duration, meetingLink, amountPence: 0,
            }),
            tutorEmail ? sendSlotBookedToTutor({
              tutorEmail, tutorName, studentName: lead.name,
              subject: lead.subject, startTime: chosenSlot, meetingLink,
            }) : Promise.resolve(),
          ]);
        } catch(e) { console.warn('Email failed:', e.message); }

        return res.status(201).json({ success: true, booking, meetingLink });
      } catch(e) {
        if (e.message.includes('bookings_no_tutor_overlap')) {
          return res.status(409).json({ error: 'That slot was just taken. Please choose a different time.', conflict: true });
        }
        if (e.message.includes('bookings_one_trial_per_student')) {
          return res.status(409).json({ error: 'This student has already used their free trial lesson.', conflict: true });
        }
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

      // Email parent confirmation + alert admin (best-effort, non-blocking)
      try {
        const { sendEnquiryConfirmation, sendAdminEnquiryAlert } = require('../lib/reminders');
        const adminEmail = process.env.ADMIN_EMAIL || 'azeemomar-mufti@outlook.com';
        await Promise.all([
          sendEnquiryConfirmation({ name, email, subject, level, goal }),
          sendAdminEnquiryAlert({ adminEmail, studentName: name, subject, level, goal, studentEmail: email }),
        ]);
      } catch(emailErr) { console.warn('Enquiry email failed:', emailErr.message); }

      return res.status(201).json({ success: true, lead });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // PATCH — update lead status / assign tutor / save proposed slots
  if (req.method === 'PATCH') {
    const { id, status, assignedTutor, notes } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Missing lead id' });
    if (!isValidId(id)) return res.status(400).json({ error: 'Invalid lead id' });
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

      // Email tutor when a student is assigned to them
      if (updates.status === 'assigned' && updates.assigned_tutor && lead) {
        try {
          const { sendTutorAssigned } = require('../lib/reminders');
          const profiles = await dbGet(`/profiles?tutor_name=eq.${encodeURIComponent(updates.assigned_tutor)}&limit=1`);
          const tutorProfile = profiles[0];
          if (tutorProfile?.email) {
            await sendTutorAssigned({
              tutorEmail: tutorProfile.email, tutorName: updates.assigned_tutor,
              studentName: lead.name || 'A new student',
              subject: lead.subject || '', level: lead.level || '',
              goal: lead.goal || '', availability: lead.availability || [],
            });
          }

          // "Calendly Booking" step: if this tutor has a Calendly event
          // type configured, send the family a single-use scheduling
          // link straight away instead of waiting for the tutor to
          // manually propose slots. Tutors without Calendly set up yet
          // keep using the manual propose-slots flow below unaffected.
          if (tutorProfile?.calendly_event_type_uri) {
            try {
              const { createSchedulingLink } = require('../lib/calendly');
              const { sendCalendlyBookingLink } = require('../lib/reminders');
              const url = await createSchedulingLink({
                eventTypeUri: tutorProfile.calendly_event_type_uri,
                trackingId: lead.id,
              });
              await sendCalendlyBookingLink({
                parentName: lead.name, parentEmail: lead.email,
                tutorName: updates.assigned_tutor, subject: lead.subject, schedulingUrl: url,
              });
            } catch(calendlyErr) { console.warn('Calendly scheduling link failed:', calendlyErr.message); }
          }
        } catch(emailErr) { console.warn('Tutor assigned email failed:', emailErr.message); }
      }

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
