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
  const {
    description, amount, due_date, category_id, supplier_id,
    supplier_name, item_description,
    payment_method, gross_amount, discount_amount,
    bank_account, cost_center, notes, origin
  } = req.body;

  const { data, error } = await supabase.from('payables')
    .insert({
      company_id: req.companyId,
      description,
      amount,
      gross_amount: gross_amount ?? null,
      discount_amount: discount_amount ?? null,
      due_date,
      category_id,
      supplier_id,
      supplier_name: supplier_name ?? null,
      item_description: item_description ?? null,
      payment_method: payment_method ?? null,
      bank_account,
      cost_center,
      notes,
      origin: origin || 'manual',
      status: 'open',
      created_by: req.user.id
    })
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
  const allowed = [
    'description','amount','due_date','category_id','supplier_id','bank_account','cost_center','notes','status',
    'supplier_name','item_description','payment_method','gross_amount','discount_amount'
  ];
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


function applyPayableListFilters(q, req) {
  const {
    search = '', status = '', category_id = '', supplier = '', date_from = '', date_to = '',
    origin = '', payment = '', item = '', desc = '', document_id = '',
  } = req.query;
  if (search) {
    q = q.or(
      `description.ilike.%${search}%,supplier_name.ilike.%${search}%,item_description.ilike.%${search}%,payment_method.ilike.%${search}%`
    );
  }
  if (status) q = q.eq('status', status);
  if (category_id) q = q.eq('category_id', category_id);
  if (supplier) q = q.ilike('supplier_name', `%${supplier}%`);
  if (date_from) q = q.gte('due_date', date_from);
  if (date_to) q = q.lte('due_date', date_to);
  if (origin) q = q.eq('origin', origin);
  if (payment) q = q.ilike('payment_method', `%${payment}%`);
  if (item) q = q.ilike('item_description', `%${item}%`);
  if (desc) q = q.ilike('description', `%${desc}%`);
  if (document_id) q = q.eq('origin', 'document').eq('origin_id', document_id);
  return q;
}

// GET /api/payables/:companyId/query — consulta avançada
router.get('/:companyId/query', authenticate, requireCompanyAccess, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(200, Math.max(1, parseInt(req.query.per_page, 10) || 50));
    const offset = (page - 1) * perPage;

    const sortKey = String(req.query.sort_by || 'due_date').toLowerCase();
    const sortAsc = String(req.query.sort_dir || 'desc').toLowerCase() === 'asc';
    const sortColMap = {
      due_date: 'due_date',
      vencimento: 'due_date',
      amount: 'amount',
      valor: 'amount',
      supplier_name: 'supplier_name',
      fornecedor: 'supplier_name',
      description: 'description',
      descricao: 'description',
      item_description: 'item_description',
      item: 'item_description',
      status: 'status',
      situacao: 'status',
      payment_method: 'payment_method',
      pgto: 'payment_method',
      discount_amount: 'discount_amount',
      desconto: 'discount_amount',
      created_at: 'created_at',
    };
    const orderCol = sortColMap[sortKey] || 'due_date';

    let query = supabase
      .from('payables')
      .select('*, category:categories(id,name)', { count: 'exact' })
      .eq('company_id', req.companyId);
    query = applyPayableListFilters(query, req);
    query = query.order(orderCol, { ascending: sortAsc }).order('id', { ascending: false }).range(offset, offset + perPage - 1);

    const { data, error, count } = await query;
    if (error) return res.status(400).json({ error: error.message });

    const SUM_CAP = 8000;
    let sumQ = supabase.from('payables').select('amount').eq('company_id', req.companyId);
    sumQ = applyPayableListFilters(sumQ, req);
    const { data: sumRows } = await sumQ.limit(SUM_CAP);
    const sum_total = (sumRows || []).reduce((s, r) => s + parseFloat(r.amount || 0), 0);
    const sum_truncated = (sumRows || []).length >= SUM_CAP;

    res.json({
      data,
      total: count,
      page,
      per_page: perPage,
      sum_total,
      sum_truncated,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
