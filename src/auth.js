const { pool } = require('./db');

async function requireAuth(req, res, next) {
  const userId = req.session && req.session.userId;
  if (!userId) return res.status(401).json({ error: 'No autenticado' });
  try {
    const { rows } = await pool.query('SELECT active FROM users WHERE id = $1', [userId]);
    if (!rows[0] || !rows[0].active) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'La cuenta está inactiva o la sesión expiró' });
    }
    return next();
  } catch (error) {
    return res.status(503).json({ error: 'No se pudo validar la sesión. Intenta de nuevo.' });
  }
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') return next();
  return res.status(403).json({ error: 'No autorizado' });
}

module.exports = { requireAuth, requireAdmin };
