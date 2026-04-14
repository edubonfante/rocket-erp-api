// logs.js
const router  = require('express').Router();
const supabase = require('../db');
const { authenticate, requireAdmin } = require('../middlewares/auth');

router.get('/', authenticate, requireAdmin, async (req, res) => {
  const { limit = 100, offset = 0, userId, module: mod } = req.query;
  let q = supabase.from('access_logs')
    .select('*, users(name,email,role)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(Number(offset), Number(offset) + Number(limit) - 1);
  if (userId) q = q.eq('user_id', userId);
  if (mod)    q = q.eq('module', mod);
  const { data, error, count } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, total: count });
});

module.exports = router;
