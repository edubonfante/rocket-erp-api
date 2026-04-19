const router  = require('express').Router();
const supabase = require('../db');
const { authenticate, requireAdmin, requireCompanyAccess } = require('../middlewares/auth');

// GET /api/companies
router.get('/', authenticate, async (req, res) => {
  let query = supabase.from('companies').select('id,name,cnpj,trade_name,email,active').eq('active', true).order('name');

  if (req.user.role !== 'admin') {
    const { data: uc } = await supabase.from('user_companies').select('company_id').eq('user_id', req.user.id);
    const ids = (uc || []).map(r => r.company_id);
    if (!ids.length) return res.json({ data: [] });
    query = query.in('id', ids);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data });
});

// POST /api/companies
router.post('/', authenticate, requireAdmin, async (req, res) => {
  const { name, cnpj, trade_name, email, phone, address, espio_cnpj_token, drive_folder_id } = req.body;
  const { data, error } = await supabase.from('companies')
    .insert({ name, cnpj, trade_name, email, phone, address, espio_cnpj_token, drive_folder_id })
    .select('*').single();

  if (error) return res.status(400).json({ error: error.message });

  // Cria categorias padrão para a empresa a partir das globais
  const { data: defaultCats } = await supabase.from('categories').select('*').is('company_id', null);
  if (defaultCats?.length) {
    await supabase.from('categories').insert(
      defaultCats.map(c => ({ ...c, id: undefined, company_id: data.id, created_at: undefined }))
    );
  }

  res.status(201).json(data);
});

// PATCH /api/companies/:id
router.patch('/:id', authenticate, requireAdmin, async (req, res) => {
  const allowed = ['name','trade_name','email','phone','address','espio_cnpj_token','drive_folder_id','active'];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  const { error } = await supabase.from('companies').update(updates).eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Empresa atualizada' });
});

// GET /api/companies/:id/categories — ?all=1 inclui inativas (tela de plano de contas)
router.get('/:id/categories',
  authenticate,
  (req, res, next) => {
    req.params.companyId = req.params.id;
    next();
  },
  requireCompanyAccess,
  async (req, res) => {
    const all = req.query.all === '1' || req.query.all === 'true';
    let q = supabase
      .from('categories')
      .select('*')
      .or(`company_id.eq.${req.params.id},company_id.is.null`)
      .order('name');
    if (!all) q = q.eq('active', true);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ data });
  }
);

// POST /api/companies/:id/categories — categoria própria da empresa (extrato + documentos)
router.post('/:id/categories', authenticate, (req, res, next) => {
  req.params.companyId = req.params.id;
  next();
}, requireCompanyAccess, async (req, res) => {
  const companyId = req.companyId;
  const { name, type = 'despesa', color = '#94a3b8', account_code: accountCode } = req.body;
  const trimmed = String(name || '').trim().slice(0, 200);
  if (!trimmed) return res.status(400).json({ error: 'Nome da categoria é obrigatório' });
  const allowedTypes = ['despesa', 'receita', 'ambos'];
  const t = allowedTypes.includes(type) ? type : 'despesa';
  const col = String(color || '').trim().slice(0, 7) || '#94a3b8';
  const code = accountCode != null ? String(accountCode).trim().slice(0, 40) : '';
  const insertPayload = { company_id: companyId, name: trimmed, type: t, color: col };
  if (code) insertPayload.account_code = code;

  const { data, error } = await supabase
    .from('categories')
    .insert(insertPayload)
    .select('id,name,type,color,account_code,active')
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH /api/companies/:id/categories/:catId — só categorias com company_id da empresa (não altera o catálogo global)
router.patch('/:id/categories/:catId',
  authenticate,
  (req, res, next) => {
    req.params.companyId = req.params.id;
    next();
  },
  requireCompanyAccess,
  async (req, res) => {
    const companyId = req.companyId;
    const catId = req.params.catId;
    const { data: row, error: fe } = await supabase
      .from('categories')
      .select('id, company_id')
      .eq('id', catId)
      .single();
    if (fe || !row) return res.status(404).json({ error: 'Categoria não encontrada' });
    if (!row.company_id || row.company_id !== companyId) {
      return res.status(403).json({
        error: 'Só é possível editar categorias próprias da empresa. As linhas "Padrão (global)" são referência do sistema.',
      });
    }

    const allowed = ['name', 'type', 'color', 'account_code', 'active'];
    const updates = Object.fromEntries(
      Object.entries(req.body || {}).filter(([k, v]) => allowed.includes(k) && v !== undefined),
    );
    if (updates.name != null) {
      const n = String(updates.name).trim().slice(0, 200);
      if (!n) return res.status(400).json({ error: 'Nome inválido' });
      updates.name = n;
    }
    if (updates.type != null) {
      const allowedTypes = ['despesa', 'receita', 'ambos'];
      if (!allowedTypes.includes(updates.type)) delete updates.type;
    }
    if (updates.color != null) {
      updates.color = String(updates.color).trim().slice(0, 7) || '#94a3b8';
    }
    if (updates.account_code != null) {
      updates.account_code = String(updates.account_code).trim().slice(0, 40) || null;
    }
    if (updates.active != null) {
      updates.active = Boolean(updates.active);
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }

    const { data, error } = await supabase
      .from('categories')
      .update(updates)
      .eq('id', catId)
      .eq('company_id', companyId)
      .select('id,name,type,color,account_code,active,company_id')
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  }
);

module.exports = router;
