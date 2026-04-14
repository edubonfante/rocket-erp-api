const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const supabase = require('../db');
const { authenticate } = require('../middlewares/auth');
const logger = require('../utils/logger');

// POST /api/auth/login
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty())
    return res.status(400).json({ errors: errors.array() });

  const { email, password } = req.body;

  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, name, email, role, password_hash, active')
      .eq('email', email)
      .single();

    if (error || !user || !user.active)
      return res.status(401).json({ error: 'Credenciais inválidas' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid)
      return res.status(401).json({ error: 'Credenciais inválidas' });

    // Busca empresas com acesso
    let companies = [];
    if (user.role === 'admin') {
      const { data } = await supabase
        .from('companies')
        .select('id, name, cnpj')
        .eq('active', true)
        .order('name')
        .limit(500);
      companies = data || [];
    } else {
      const { data } = await supabase
        .from('user_companies')
        .select('companies(id, name, cnpj)')
        .eq('user_id', user.id);
      companies = (data || []).map(d => d.companies);
    }

    // Permissões
    const { data: perms } = await supabase
      .from('user_permissions')
      .select('module, can_view, can_edit')
      .eq('user_id', user.id);

    // Atualiza last_login
    await supabase.from('users').update({ last_login: new Date() }).eq('id', user.id);

    // Log
    await supabase.from('access_logs').insert({
      user_id: user.id,
      action: 'login',
      module: 'auth',
      ip_address: req.ip,
      user_agent: req.headers['user-agent'],
    });

    const token = jwt.sign(
      { sub: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    logger.info(`Login: ${email} [${user.role}]`);

    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      companies,
      permissions: perms || [],
    });
  } catch (err) {
    logger.error('Login error:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// GET /api/auth/me — retorna dados do usuário logado
router.get('/me', authenticate, async (req, res) => {
  const { data: user } = await supabase
    .from('users')
    .select('id, name, email, role, last_login')
    .eq('id', req.user.id)
    .single();
  res.json(user);
});

// POST /api/auth/logout
router.post('/logout', authenticate, async (req, res) => {
  await supabase.from('access_logs').insert({
    user_id: req.user.id,
    action: 'logout',
    module: 'auth',
    ip_address: req.ip,
  });
  res.json({ message: 'Logout registrado' });
});

// POST /api/auth/change-password
router.post('/change-password', authenticate, [
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 8 }),
], async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  const { data: user } = await supabase
    .from('users').select('password_hash').eq('id', req.user.id).single();

  const valid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!valid) return res.status(400).json({ error: 'Senha atual incorreta' });

  const hash = await bcrypt.hash(newPassword, 12);
  await supabase.from('users').update({ password_hash: hash }).eq('id', req.user.id);

  res.json({ message: 'Senha alterada com sucesso' });
});

module.exports = router;
