const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const supabase = require('../db');
const { authenticate, requireAdmin } = require('../middlewares/auth');

// GET /api/users — lista todos os usuários (admin only)
router.get('/', authenticate, requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select(`
      id, name, email, role, active, last_login, created_at,
      user_companies(companies(id, name, cnpj)),
      user_permissions(module, can_view, can_edit)
    `)
    .order('name');

  if (error) return res.status(500).json({ error: error.message });
  res.json({ data });
});

// POST /api/users — cria novo usuário
router.post('/', authenticate, requireAdmin, async (req, res) => {
  const { name, email, password, role, companies, permissions } = req.body;

  if (!name || !email || !password || !role)
    return res.status(400).json({ error: 'name, email, password, role são obrigatórios' });

  const hash = await bcrypt.hash(password, 12);

  const { data: user, error } = await supabase
    .from('users')
    .insert({ name, email: email.toLowerCase(), password_hash: hash, role })
    .select('id, name, email, role').single();

  if (error) return res.status(400).json({ error: error.message });

  // Vincula empresas
  if (companies?.length && role !== 'admin') {
    await supabase.from('user_companies').insert(
      companies.map(cid => ({ user_id: user.id, company_id: cid }))
    );
  }

  // Define permissões (operadores)
  if (permissions?.length && role === 'operator') {
    await supabase.from('user_permissions').insert(
      permissions.map(p => ({ user_id: user.id, module: p.module, can_view: p.can_view ?? true, can_edit: p.can_edit ?? false }))
    );
  }

  // Log
  await supabase.from('access_logs').insert({
    user_id: req.user.id, action: `Criou usuário: ${email}`, module: 'usuarios',
    details: { role, companies },
  });

  res.status(201).json({ message: 'Usuário criado com sucesso', user });
});

// PATCH /api/users/:id — atualiza usuário
router.patch('/:id', authenticate, requireAdmin, async (req, res) => {
  const { name, email, password, role, active, companies, permissions } = req.body;
  const { id } = req.params;

  const updates = {};
  if (name)     updates.name = name;
  if (email)    updates.email = email.toLowerCase();
  if (role)     updates.role = role;
  if (active !== undefined) updates.active = active;
  if (password) updates.password_hash = await bcrypt.hash(password, 12);

  if (Object.keys(updates).length) {
    const { error } = await supabase.from('users').update(updates).eq('id', id);
    if (error) return res.status(400).json({ error: error.message });
  }

  // Atualiza empresas
  if (companies !== undefined) {
    await supabase.from('user_companies').delete().eq('user_id', id);
    if (companies.length) {
      await supabase.from('user_companies').insert(companies.map(cid => ({ user_id: id, company_id: cid })));
    }
  }

  // Atualiza permissões
  if (permissions !== undefined) {
    await supabase.from('user_permissions').delete().eq('user_id', id);
    if (permissions.length) {
      await supabase.from('user_permissions').insert(
        permissions.map(p => ({ user_id: id, module: p.module, can_view: p.can_view ?? true, can_edit: p.can_edit ?? false }))
      );
    }
  }

  res.json({ message: 'Usuário atualizado' });
});

// DELETE /api/users/:id — desativa usuário (soft delete)
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  if (req.params.id === req.user.id)
    return res.status(400).json({ error: 'Você não pode desativar sua própria conta' });

  await supabase.from('users').update({ active: false }).eq('id', req.params.id);
  res.json({ message: 'Usuário desativado' });
});

module.exports = router;
