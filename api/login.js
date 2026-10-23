const { Genesis, pull } = require('../lib/genesis');
const crypto = require('crypto');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { user, pass } = req.body || {};
  if (typeof user !== 'string' || typeof pass !== 'string' || !user.trim() || !pass) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  try {
    const g = new Genesis();
    g.accountKey = crypto.createHash('sha256').update(user.trim().toLowerCase()).digest('hex').slice(0, 24);
    await g.login(user.trim(), pass);
    const data = await pull(g);
    return res.status(200).json(data);
  } catch (e) {
    const message = String(e?.message || 'Could not sign in to Genesis');
    const status = /rejected the login|could not find a student id|SSO\/MFA/i.test(message) ? 401 : 502;
    return res.status(status).json({ error: message, ...(process.env.DEBUG === '1' && e?.debug ? { debug: e.debug } : {}) });
  }
};
