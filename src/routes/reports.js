const router   = require('express').Router();
const supabase = require('../db');
const { authenticate, requireCompanyAccess, requirePermission } = require('../middlewares/auth');
const { classifyPayableForDre } = require('../utils/dreAnalyticMap');
const { computeDre } = require('../utils/dreCompute');
const { buildDreXlsxBuffer } = require('../utils/dreXlsxBuffer');

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

// GET /api/reports/:companyId/dre/drill — detalhe por “caixa” da DRE (vendas, extrato receita, contas a pagar)
router.get('/:companyId/dre/drill',
  authenticate, requireCompanyAccess, requirePermission('dre'),
  async (req, res) => {
    const { bucket, dateFrom, dateTo, categoryId } = req.query;
    const lim = Math.min(500, Math.max(1, parseInt(String(req.query.limit || '80'), 10) || 80));
    const off = Math.max(0, parseInt(String(req.query.offset || '0'), 10) || 0);
    const df = dateFrom || '2000-01-01';
    const dt = dateTo || '2099-12-31';
    const catFilter = categoryId && String(categoryId).trim() ? String(categoryId).trim() : null;

    const allowed = new Set([
      'receita_bruta',
      'devolucoes',
      'impostos_vendas',
      'cmv',
      'pessoal',
      'admin',
      'depreciacao',
      'financeiras',
      'irpj',
    ]);
    if (!bucket || !allowed.has(String(bucket))) {
      return res.status(400).json({ error: 'Parâmetro bucket inválido ou ausente' });
    }

    const mapPayableRow = (p) => ({
      kind: 'payable',
      id: p.id,
      date: p.due_date,
      description: p.description,
      category: p.categories?.name || null,
      supplier: p.suppliers?.name || null,
      amount: fmt(parseFloat(p.amount)),
      status: p.status,
      origin: p.origin,
    });

    try {
      if (bucket === 'depreciacao') {
        return res.json({
          bucket,
          total: 0,
          rows: [],
          note: 'Depreciação na DRE é estimativa (percentual); não há lançamentos individuais aqui.',
        });
      }

      if (bucket === 'receita_bruta') {
        let qs = supabase
          .from('sales')
          .select('id, sale_date, gross_value, discount, net_value, payment_method, cancelled, categories(name)')
          .eq('company_id', req.companyId)
          .eq('cancelled', false)
          .gte('sale_date', df)
          .lte('sale_date', dt);
        if (catFilter) qs = qs.eq('category_id', catFilter);
        const { data: saleRows, error: sErr } = await qs.order('sale_date', { ascending: false }).limit(2500);
        if (sErr) return res.status(500).json({ error: sErr.message });

        let qb = supabase
          .from('bank_entries')
          .select('id, entry_date, description, amount, status, categories(name, type)')
          .eq('company_id', req.companyId)
          .eq('status', 'classified')
          .not('category_id', 'is', null)
          .gt('amount', 0)
          .gte('entry_date', df)
          .lte('entry_date', dt);
        if (catFilter) qb = qb.eq('category_id', catFilter);
        const { data: bankRows, error: bErr } = await qb.order('entry_date', { ascending: false }).limit(2500);
        if (bErr) return res.status(500).json({ error: bErr.message });

        const merged = [];
        for (const r of saleRows || []) {
          merged.push({
            kind: 'sale',
            id: r.id,
            date: r.sale_date,
            description: `${r.payment_method || '—'} · venda importada`,
            category: r.categories?.name || null,
            amount: fmt(parseFloat(r.gross_value)),
            payment_method: r.payment_method,
            cancelled: r.cancelled,
          });
        }
        for (const b of bankRows || []) {
          const ty = String(b.categories?.type || '');
          if (ty !== 'receita' && ty !== 'ambos') continue;
          merged.push({
            kind: 'bank_entry',
            id: b.id,
            date: b.entry_date,
            description: b.description || 'Entrada no extrato',
            category: b.categories?.name || null,
            amount: fmt(parseFloat(b.amount)),
            status: b.status,
            origin: 'conciliacao',
          });
        }
        merged.sort((a, b) => String(b.date).localeCompare(String(a.date)));
        const total = merged.length;
        const slice = merged.slice(off, off + lim);
        return res.json({
          bucket,
          total,
          rows: slice,
          offset: off,
          limit: lim,
          note: total >= 5000 ? 'Lista limitada a 5000 lançamentos mais recentes para desempenho.' : null,
        });
      }

      if (bucket === 'devolucoes') {
        let qs = supabase
          .from('sales')
          .select('id, sale_date, gross_value, discount, net_value, payment_method, cancelled, categories(name)')
          .eq('company_id', req.companyId)
          .gte('sale_date', df)
          .lte('sale_date', dt)
          .or('cancelled.eq.true,discount.gt.0');
        if (catFilter) qs = qs.eq('category_id', catFilter);
        const { data: saleRows, error: sErr } = await qs.order('sale_date', { ascending: false }).limit(2500);
        if (sErr) return res.status(500).json({ error: sErr.message });

        const { data: payRows, error: pErr } = await supabase
          .from('payables')
          .select('id, description, amount, due_date, status, origin, category_id, categories(id,name,account_code,type), suppliers(name)')
          .eq('company_id', req.companyId)
          .in('status', ['open', 'overdue', 'paid'])
          .gte('due_date', df)
          .lte('due_date', dt)
          .order('due_date', { ascending: false })
          .limit(4000);
        if (pErr) return res.status(500).json({ error: pErr.message });

        const merged = [];
        for (const r of saleRows || []) {
          merged.push({
            kind: 'sale',
            id: r.id,
            date: r.sale_date,
            description: r.cancelled ? 'Cancelamento / estorno' : 'Desconto na venda',
            category: r.categories?.name || null,
            amount: fmt(parseFloat(r.discount || 0) + (r.cancelled ? parseFloat(r.net_value || 0) : 0)),
            payment_method: r.payment_method,
            cancelled: r.cancelled,
          });
        }
        for (const p of payRows || []) {
          if (classifyPayableForDre(p.categories).drillBucket !== 'devolucoes') continue;
          if (catFilter && String(p.category_id) !== catFilter) continue;
          merged.push(mapPayableRow(p));
        }
        merged.sort((a, b) => String(b.date).localeCompare(String(a.date)));
        const total = merged.length;
        const slice = merged.slice(off, off + lim);
        return res.json({ bucket, total, rows: slice, offset: off, limit: lim });
      }

      const { data: payRows, error: pErr } = await supabase
        .from('payables')
        .select(
          'id, description, amount, due_date, status, origin, category_id, categories(id,name,account_code,type), suppliers(name)',
        )
        .eq('company_id', req.companyId)
        .in('status', ['open', 'overdue', 'paid'])
        .gte('due_date', df)
        .lte('due_date', dt)
        .order('due_date', { ascending: false })
        .limit(6000);

      if (pErr) return res.status(500).json({ error: pErr.message });

      const wantBucket = String(bucket);
      const filtered = (payRows || []).filter((p) => {
        if (catFilter && String(p.category_id) !== catFilter) return false;
        return classifyPayableForDre(p.categories).drillBucket === wantBucket;
      });
      const total = filtered.length;
      const slice = filtered.slice(off, off + lim);
      const rows = slice.map(mapPayableRow);

      return res.json({ bucket, total, rows, offset: off, limit: lim });
    } catch (e) {
      return res.status(500).json({ error: e.message || 'Erro no drill-down' });
    }
  }
);

// GET /api/reports/:companyId/dre/export — DRE em .xlsx (ExcelJS no servidor)
router.get('/:companyId/dre/export',
  authenticate, requireCompanyAccess, requirePermission('dre'),
  async (req, res) => {
    try {
      const { dateFrom, dateTo } = req.query;
      const d = await computeDre(supabase, req.companyId, dateFrom, dateTo);
      const buffer = await buildDreXlsxBuffer(d, dateFrom || '', dateTo || '');
      const safe = (s) => String(s || '').replace(/[^\d-]/g, '') || 'x';
      const fn = `dre_${safe(dateFrom)}_${safe(dateTo)}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${fn}"`);
      res.send(Buffer.from(buffer));
    } catch (e) {
      res.status(500).json({ error: e.message || 'Erro ao gerar Excel' });
    }
  }
);

// GET /api/reports/:companyId/dre — DRE
router.get('/:companyId/dre',
  authenticate, requireCompanyAccess, requirePermission('dre'),
  async (req, res) => {
    try {
      const { dateFrom, dateTo } = req.query;
      const d = await computeDre(supabase, req.companyId, dateFrom, dateTo);
      res.json(d);
    } catch (e) {
      res.status(500).json({ error: e.message || 'Erro ao montar DRE' });
    }
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
