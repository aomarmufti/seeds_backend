// api/health.js
// Vercel serverless function — GET /api/health
// Confirms the server is alive and which services are configured.

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    status: 'ok',
    stripe: !!process.env.STRIPE_SECRET_KEY,
    email: !!process.env.RESEND_API_KEY,
    sms: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
    timestamp: new Date().toISOString(),
  });
};
