// api/analytics.js — GET /api/analytics
const { applyCors } = require('../lib/cors');
const { dbGet } = require('../lib/db');

const TUTOR_CUT = 0.78;

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const [bookings, students, payouts] = await Promise.all([
      dbGet('/bookings?select=*,students(student_name,parent_email)&order=start_time.desc'),
      dbGet('/students?select=id,student_name,parent_email,created_at'),
      dbGet('/payouts?select=*&order=requested_at.desc'),
    ]);

    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const paid = bookings.filter(b => b.fee_pence > 0);

    const totalRevenue = paid.reduce((s, b) => s + b.fee_pence, 0);
    const thisMonth    = paid.filter(b => new Date(b.start_time) >= thisMonthStart)
                             .reduce((s, b) => s + b.fee_pence, 0);
    const lastMonth    = paid.filter(b => {
      const d = new Date(b.start_time);
      return d >= lastMonthStart && d < thisMonthStart;
    }).reduce((s, b) => s + b.fee_pence, 0);

    // Monthly chart: last 12 months
    const monthly = {};
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      monthly[key] = 0;
    }
    paid.forEach(b => {
      const d = new Date(b.start_time);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      if (key in monthly) monthly[key] += b.fee_pence;
    });

    // Lesson type breakdown
    const byType = { gcse: 0, alevel: 0, group: 0, trial: 0 };
    bookings.forEach(b => { if (b.lesson_type in byType) byType[b.lesson_type]++; });

    // Per-tutor
    const tutorMap = {};
    bookings.forEach(b => {
      if (!tutorMap[b.tutor_name]) tutorMap[b.tutor_name] = { lessons: 0, revenue: 0, unpaid: 0 };
      tutorMap[b.tutor_name].lessons++;
      tutorMap[b.tutor_name].revenue += b.fee_pence;
    });
    bookings.filter(b => b.status === 'confirmed' && b.fee_pence > 0).forEach(b => {
      if (tutorMap[b.tutor_name])
        tutorMap[b.tutor_name].unpaid += Math.round(b.fee_pence * TUTOR_CUT);
    });

    res.status(200).json({
      revenue: { total: totalRevenue, thisMonth, lastMonth },
      monthly,
      byType,
      tutors: tutorMap,
      studentCount: students.length,
      bookingCount: bookings.length,
      recentBookings: bookings.slice(0, 15).map(b => ({
        id: b.id,
        studentName: b.students?.student_name || '—',
        tutorName: b.tutor_name,
        subject: b.subject,
        lessonType: b.lesson_type,
        startTime: b.start_time,
        feePence: b.fee_pence,
        status: b.status,
      })),
      payouts: payouts.slice(0, 10),
    });
  } catch (err) {
    console.error('analytics error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
