const router  = require('express').Router();
const supabase = require('../db');
const { authenticate, requireCompanyAccess, requirePermission } = require('../middlewares/auth');

// GET /api/payables/:companyId
router.get('/:companyId', authenticate, requireCompanyAccess, requirePermission('contas'), async (req, res) => {
  const { status, dateFrom, dateTo, limit = 100, offset = 0 } = req.query;
  let q = supabase.from('payables')
    .select('*, categories(name,color), suppliers(name,cnpj_cpf)', { count: 'exact' })
    .eq('company_id', req.companyId)
    .order('due_date', { ascending: true })
    .range(Number(offset), Number(offset) + Number(limit) - 1);

  if (status)   q = q.eq('status', status);
  if (dateFrom) q = q.gte('due_date', dateFrom);
  if (dateTo)   q = q.lte('due_date', dateTo);

  // Atualiza status de vencidos automaticamente
  await supabase.from('payables')
    .update({ status: 'overdue' })
    .eq('company_id', req.companyId)
    .eq('status', 'open')
    .lt('due_date', new Date().toISOString().split('T')[0]);

  const { data, error, count } = await q;
  if (error) return res.status(500).json({ error: error.message });

  // Calcula totais
  const { data: totals } = await supabase.from('payables')
    .select('status, amount')
    .eq('company_id', req.companyId)
    .in('status', ['open','overdue']);

  const summary = {
    open:    0, overdue: 0, due_today: 0,
    total:   0, count: count || 0,
  };
  const today = new Date().toISOString().split('T')[0];
  for (const t of (totals||[])) {
    summary[t.status] += parseFloat(t.amount);
    summary.total     += parseFloat(t.amount);
  }
  summary.open    = Math.round(summary.open    * 100) / 100;
  summary.overdue = Math.round(summary.overdue * 100) / 100;
  summary.total   = Math.round(summary.total   * 100) / 100;

  res.json({ data, total: count, summary });
});

// POST /api/payables/:companyId
router.post('/:companyId', authenticate, requireCompanyAccess, requirePermission('contas'), async (req, res) => {
  const { description, amount, due_date, category_id, supplier_id, bank_account, cost_center, notes, origin } = req.body;

  const { data, error } = await supabase.from('payables')
    .insert({ company_id: req.companyId, description, amount, due_date, category_id, supplier_id, bank_account, cost_center, notes, origin: origin || 'manual', status: 'open', created_by: req.user.id })
    .select('*').single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH /api/payables/:companyId/:id/pay — marca como pago
router.patch('/:companyId/:id/pay', authenticate, requireCompanyAccess, requirePermission('contas'), async (req, res) => {
  const { paid_amount, paid_date } = req.body;
  const { error } = await supabase.from('payables')
    .update({ status: 'paid', paid_amount: paid_amount || null, paid_date: paid_date || new Date().toISOString().split('T')[0] })
    .eq('id', req.params.id).eq('company_id', req.companyId);

  if (error) return res.status(400).json({ error: error.message });

  await supabase.from('access_logs').insert({ user_id: req.user.id, company_id: req.companyId, action: `Pagou conta: ${req.params.id}`, module: 'contas' });
  res.json({ message: 'Conta marcada como paga' });
});

// PATCH /api/payables/:companyId/:id — edita conta
router.patch('/:companyId/:id', authenticate, requireCompanyAccess, requirePermission('contas'), async (req, res) => {
  const allowed = ['description','amount','due_date','category_id','supplier_id','bank_account','cost_center','notes','status'];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  const { error } = await supabase.from('payables').update(updates).eq('id', req.params.id).eq('company_id', req.companyId);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Atualizado' });
});

// DELETE /api/payables/:companyId/:id
router.delete('/:companyId/:id', authenticate, requireCompanyAccess, requirePermission('contas'), async (req, res) => {
  await supabase.from('payables').update({ status: 'cancelled' }).eq('id', req.params.id).eq('company_id', req.companyId);
  res.json({ message: 'Conta cancelada' });
});

module.exports = router;
