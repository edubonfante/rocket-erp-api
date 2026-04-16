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

// GET /api/companies/:id/categories
router.get('/:id/categories', authenticate, async (req, res) => {
  const { data, error } = await supabase.from('categories')
    .select('*').or(`company_id.eq.${req.params.id},company_id.is.null`)
    .eq('active', true).order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data });
});

// POST /api/companies/:id/categories — categoria própria da empresa (extrato + documentos)
router.post('/:id/categories', authenticate, (req, res, next) => {
  req.params.companyId = req.params.id;
  next();
}, requireCompanyAccess, async (req, res) => {
  const companyId = req.companyId;
  const { name, type = 'despesa', color = '#94a3b8' } = req.body;
  const trimmed = String(name || '').trim().slice(0, 200);
  if (!trimmed) return res.status(400).json({ error: 'Nome da categoria é obrigatório' });
  const allowedTypes = ['despesa', 'receita', 'ambos'];
  const t = allowedTypes.includes(type) ? type : 'despesa';
  const col = String(color || '').trim().slice(0, 7) || '#94a3b8';

  const { data, error } = await supabase
    .from('categories')
    .insert({ company_id: companyId, name: trimmed, type: t, color: col })
    .select('id,name,type,color')
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

module.exports = router;
