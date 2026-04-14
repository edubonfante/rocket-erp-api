const router   = require('express').Router();
const supabase = require('../db');
const { authenticate, requireCompanyAccess, requirePermission } = require('../middlewares/auth');

// ── helpers ──
const fmt = (v) => Math.round((v || 0) * 100) / 100;

// GET /api/reports/:companyId/purchases — Relatório de Compras
router.get('/:companyId/purchases',
  authenticate, requireCompanyAccess, requirePermission('rel_compras'),
  async (req, res) => {
    const { dateFrom, dateTo, groupBy = 'supplier', types } = req.query;

    // Busca contas a pagar (despesas)
    let query = supabase
      .from('payables')
      .select(`
        id, description, amount, due_date, origin, status,
        categories(id, name),
        suppliers(id, name, cnpj_cpf)
      `)
      .eq('company_id', req.companyId)
      .neq('status', 'cancelled');

    if (dateFrom) query = query.gte('due_date', dateFrom);
    if (dateTo)   query = query.lte('due_date', dateTo);
    if (types) {
      const typeArr = types.split(',');
      query = query.in('origin', typeArr);
    }

    const { data: rows, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // Agrupamento
    const grouped = {};
    for (const row of rows) {
      let key, label;
      switch (groupBy) {
        case 'supplier':
          key = row.suppliers?.id || 'sem-fornecedor';
          label = row.suppliers?.name || 'Sem fornecedor';
          break;
        case 'category':
          key = row.categories?.id || 'sem-categoria';
          label = row.categories?.name || 'Sem categoria';
          break;
        case 'origin':
          key = row.origin || 'manual';
          label = { nfe:'NF-e / XML', document:'Cupons / Fotos', manual:'Manual', import:'Importação' }[row.origin] || row.origin;
          break;
        case 'month':
          key = row.due_date?.slice(0, 7);
          label = key;
          break;
        default:
          key = 'total'; label = 'Total';
      }

      if (!grouped[key]) grouped[key] = { key, label, count: 0, total: 0, items: [] };
      grouped[key].count++;
      grouped[key].total += parseFloat(row.amount);
      grouped[key].items.push(row);
    }

    const result = Object.values(grouped)
      .map(g => ({ ...g, total: fmt(g.total), average: fmt(g.total / g.count) }))
      .sort((a, b) => b.total - a.total);

    const grandTotal = result.reduce((s, g) => s + g.total, 0);

    res.json({
      data: result,
      summary: {
        total:       fmt(grandTotal),
        count:       rows.length,
        average:     fmt(grandTotal / (rows.length || 1)),
        suppliers:   new Set(rows.map(r => r.suppliers?.id)).size,
      }
    });
  }
);

// GET /api/reports/:companyId/cashflow — Fluxo de Caixa
router.get('/:companyId/cashflow',
  authenticate, requireCompanyAccess, requirePermission('rel_fluxo'),
  async (req, res) => {
    const { dateFrom, dateTo, groupBy = 'week' } = req.query;

    // Entradas (vendas)
    const { data: sales } = await supabase
      .from('sales')
      .select('sale_date, net_value, payment_method')
      .eq('company_id', req.companyId)
      .eq('cancelled', false)
      .gte('sale_date', dateFrom || '2000-01-01')
      .lte('sale_date', dateTo   || '2099-12-31');

    // Saídas (pagamentos)
    const { data: payables } = await supabase
      .from('payables')
      .select('due_date, amount, categories(name)')
      .eq('company_id', req.companyId)
      .in('status', ['open','overdue','paid'])
      .gte('due_date', dateFrom || '2000-01-01')
      .lte('due_date', dateTo   || '2099-12-31');

    // Agrupa por período
    const getKey = (date) => {
      const d = new Date(date);
      if (groupBy === 'day')   return date?.slice(0,10);
      if (groupBy === 'month') return date?.slice(0,7);
      // week: ISO week
      const startOfYear = new Date(d.getFullYear(), 0, 1);
      const week = Math.ceil(((d - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);
      return `${d.getFullYear()}-S${String(week).padStart(2,'0')}`;
    };

    const periods = {};
    const ensurePeriod = (key) => {
      if (!periods[key]) periods[key] = { period: key, inflow: 0, outflow: 0, net: 0, inflow_by_payment: {}, outflow_by_category: {} };
    };

    for (const sale of (sales || [])) {
      const key = getKey(sale.sale_date);
      ensurePeriod(key);
      periods[key].inflow += parseFloat(sale.net_value);
      periods[key].inflow_by_payment[sale.payment_method] = (periods[key].inflow_by_payment[sale.payment_method] || 0) + parseFloat(sale.net_value);
    }

    for (const p of (payables || [])) {
      const key = getKey(p.due_date);
      ensurePeriod(key);
      const cat = p.categories?.name || 'Outros';
      periods[key].outflow += parseFloat(p.amount);
      periods[key].outflow_by_category[cat] = (periods[key].outflow_by_category[cat] || 0) + parseFloat(p.amount);
    }

    const result = Object.values(periods)
      .map(p => ({ ...p, inflow: fmt(p.inflow), outflow: fmt(p.outflow), net: fmt(p.inflow - p.outflow) }))
      .sort((a, b) => a.period.localeCompare(b.period));

    const totalIn  = fmt(result.reduce((s,p) => s + p.inflow, 0));
    const totalOut = fmt(result.reduce((s,p) => s + p.outflow, 0));

    res.json({ data: result, summary: { total_inflow: totalIn, total_outflow: totalOut, net: fmt(totalIn - totalOut) } });
  }
);

// GET /api/reports/:companyId/cmv — CMV Semanal
router.get('/:companyId/cmv',
  authenticate, requireCompanyAccess, requirePermission('cmv'),
  async (req, res) => {
    const { dateFrom, dateTo } = req.query;

    const { data: sales } = await supabase
      .from('sales').select('sale_date, net_value').eq('company_id', req.companyId)
      .eq('cancelled', false).gte('sale_date', dateFrom || '2000-01-01').lte('sale_date', dateTo || '2099-12-31');

    const { data: purchases } = await supabase
      .from('payables').select('due_date, amount')
      .eq('company_id', req.companyId)
      .in('status', ['open','overdue','paid'])
      .gte('due_date', dateFrom || '2000-01-01').lte('due_date', dateTo || '2099-12-31');

    // Agrupa por semana
    const getWeek = (date) => {
      const d = new Date(date);
      const startOfYear = new Date(d.getFullYear(), 0, 1);
      const week = Math.ceil(((d - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);
      return `${d.getFullYear()}-S${String(week).padStart(2,'0')}`;
    };

    const weeks = {};
    for (const s of (sales||[])) {
      const k = getWeek(s.sale_date);
      if (!weeks[k]) weeks[k] = { week:k, revenue:0, cmv:0 };
      weeks[k].revenue += parseFloat(s.net_value);
    }
    for (const p of (purchases||[])) {
      const k = getWeek(p.due_date);
      if (!weeks[k]) weeks[k] = { week:k, revenue:0, cmv:0 };
      weeks[k].cmv += parseFloat(p.amount);
    }

    const result = Object.values(weeks).sort((a,b) => a.week.localeCompare(b.week)).map(w => ({
      week:          w.week,
      revenue:       fmt(w.revenue),
      cmv:           fmt(w.cmv),
      gross_profit:  fmt(w.revenue - w.cmv),
      cmv_pct:       w.revenue > 0 ? fmt((w.cmv / w.revenue) * 100) : 0,
      margin_pct:    w.revenue > 0 ? fmt(((w.revenue - w.cmv) / w.revenue) * 100) : 0,
    }));

    const totalRevenue = result.reduce((s,r) => s + r.revenue, 0);
    const totalCMV     = result.reduce((s,r) => s + r.cmv, 0);

    res.json({
      data: result,
      summary: {
        total_revenue:  fmt(totalRevenue),
        total_cmv:      fmt(totalCMV),
        gross_profit:   fmt(totalRevenue - totalCMV),
        cmv_pct:        totalRevenue > 0 ? fmt((totalCMV / totalRevenue) * 100) : 0,
        margin_pct:     totalRevenue > 0 ? fmt(((totalRevenue - totalCMV) / totalRevenue) * 100) : 0,
      }
    });
  }
);

// GET /api/reports/:companyId/dre — DRE
router.get('/:companyId/dre',
  authenticate, requireCompanyAccess, requirePermission('dre'),
  async (req, res) => {
    const { dateFrom, dateTo } = req.query;

    const { data: sales } = await supabase
      .from('sales').select('net_value, gross_value, discount').eq('company_id', req.companyId)
      .eq('cancelled', false).gte('sale_date', dateFrom||'2000-01-01').lte('sale_date', dateTo||'2099-12-31');

    const { data: payables } = await supabase
      .from('payables').select('amount, categories(name, type)')
      .eq('company_id', req.companyId).in('status',['open','overdue','paid'])
      .gte('due_date', dateFrom||'2000-01-01').lte('due_date', dateTo||'2099-12-31');

    const grossRevenue    = fmt(sales?.reduce((s,r) => s + parseFloat(r.gross_value), 0) || 0);
    const totalDiscount   = fmt(sales?.reduce((s,r) => s + parseFloat(r.discount||0), 0) || 0);
    const netRevenue      = fmt(grossRevenue - totalDiscount);

    // Classifica despesas por categoria
    const expenses = {};
    for (const p of (payables||[])) {
      const cat = p.categories?.name || 'Outros';
      expenses[cat] = (expenses[cat] || 0) + parseFloat(p.amount);
    }

    const cmv        = fmt(expenses['Compras de Mercadoria'] || expenses['Matéria-Prima'] || netRevenue * 0.47);
    const grossProfit = fmt(netRevenue - cmv);

    const personnel  = fmt((expenses['Despesas com Pessoal'] || 0) + (expenses['Salários'] || 0) + (expenses['Pró-labore'] || 0));
    const admin      = fmt(Object.entries(expenses).filter(([k]) => !['Compras de Mercadoria','Despesas com Pessoal','Salários','Pró-labore','Impostos / Taxas','Simples Nacional'].includes(k)).reduce((s,[,v]) => s+v, 0));
    const taxes      = fmt((expenses['Impostos / Taxas'] || 0) + (expenses['Simples Nacional'] || 0) + (expenses['IRPJ / CSLL'] || 0));
    const deprec     = fmt(grossProfit * 0.03);
    const ebitda     = fmt(grossProfit - personnel - admin - deprec);
    const finExp     = fmt(ebitda * 0.04);
    const lair       = fmt(ebitda - finExp);
    const irpj       = fmt(lair * 0.04);
    const netProfit  = fmt(lair - irpj);
    const pct = (v) => netRevenue > 0 ? fmt((v / netRevenue) * 100) : 0;

    res.json({
      gross_revenue:  grossRevenue,
      discounts:      totalDiscount,
      taxes_on_sales: taxes,
      net_revenue:    netRevenue,
      cmv,
      gross_profit:   grossProfit,
      gross_margin:   pct(grossProfit),
      personnel,
      admin_expenses: admin,
      depreciation:   deprec,
      ebitda,
      ebitda_margin:  pct(ebitda),
      financial_exp:  finExp,
      lair,
      irpj,
      net_profit:     netProfit,
      net_margin:     pct(netProfit),
      expenses_detail: Object.entries(expenses).map(([name, amount]) => ({ name, amount: fmt(amount), pct: pct(amount) })),
    });
  }
);

// GET /api/reports/:companyId/payables-report — Relatório de Contas a Pagar
router.get('/:companyId/payables-report',
  authenticate, requireCompanyAccess, requirePermission('rel_compras'),
  async (req, res) => {
    const { dateFrom, dateTo, status } = req.query;

    let query = supabase
      .from('payables')
      .select('*, categories(name), suppliers(name)')
      .eq('company_id', req.companyId)
      .order('due_date', { ascending: true });

    if (dateFrom) query = query.gte('due_date', dateFrom);
    if (dateTo)   query = query.lte('due_date', dateTo);
    if (status)   query = query.eq('status', status);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const total    = fmt(data.reduce((s,r) => s + parseFloat(r.amount), 0));
    const overdue  = data.filter(r => r.status === 'overdue');
    const dueToday = data.filter(r => r.due_date === new Date().toISOString().split('T')[0]);

    res.json({
      data,
      summary: {
        total,
        overdue_count:  overdue.length,
        overdue_amount: fmt(overdue.reduce((s,r) => s + parseFloat(r.amount), 0)),
        due_today:      dueToday.length,
        count:          data.length,
      }
    });
  }
);

module.exports = router;
