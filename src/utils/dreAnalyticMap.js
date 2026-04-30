/**
 * Mapeia categorias do plano (account_code + nome) → linhas da DRE e níveis analíticos L2/L3,
 * alinhado ao plano varejo em supabase/migrations/008_replace_categories_with_chart.sql
 */

const { payableDreBucket } = require('./dreBuckets');

/**
 * @param {{ name?: string, account_code?: string|null, type?: string|null }|null} cat
 * @returns {{ drillBucket: string, l2: string, l3: string, code: string }}
 */
function classifyPayableForDre(cat) {
  const code = String(cat?.account_code || '').trim();
  const name = String(cat?.name || '—').trim() || '—';
  // dre_group definido pelo Kanban do plano de contas tem prioridade
  if (cat?.dre_group) {
    const _g = cat.dre_group;
    const _n = String(cat?.name || '-').trim() || '-';
    const _c = String(cat?.account_code || '').trim();
    const _bmap = {
      cmv:          { drillBucket: 'cmv',           l2: 'CMV / Custos sobre vendas',    l3: _n, code: _c },
      personnel:    { drillBucket: 'personnel',     l2: 'Despesas com Pessoal',          l3: _n, code: _c },
      admin:        { drillBucket: 'admin',         l2: 'Despesas Operacionais (Fixas)', l3: _n, code: _c },
      variable:     { drillBucket: 'variable',      l2: 'Despesas Variveis',           l3: _n, code: _c },
      financial:    { drillBucket: 'financial',     l2: 'Despesas Financeiras',          l3: _n, code: _c },
      revenue:      { drillBucket: 'gross_revenue', l2: 'Receita Bruta de Vendas',       l3: _n, code: _c },
      tax:          { drillBucket: 'taxes_on_sales',l2: 'Impostos sobre vendas',         l3: _n, code: _c },
      discount:     { drillBucket: 'discounts',     l2: 'Dedues / devolues',         l3: _n, code: _c },
      irpj:         { drillBucket: 'irpj',          l2: 'IRPJ / CSLL',                  l3: _n, code: _c },
      investment:   { drillBucket: 'investments',   l2: 'Investimentos / CAPEX',         l3: _n, code: _c },
      non_operating:{ drillBucket: 'non_operating', l2: 'No Operacional',              l3: _n, code: _c },
    };
    if (_bmap[_g]) return _bmap[_g];
  }
  const legacy = payableDreBucket(name);

  const byLegacy = classifyPayableByLegacy(legacy, name, code);
  const byCode = classifyPayableByCode(code, name);
  if (!byCode) return byLegacy;

  /*
   * account_code pode ficar defasado quando o usuário reorganiza categorias
   * no Kanban do plano de contas. Em caso de conflito, priorizamos um bucket
   * semântico forte (name-based) para manter a DRE coerente com o plano atual.
   */
  if (legacy !== 'admin' && byLegacy.drillBucket !== byCode.drillBucket) {
    return byLegacy;
  }
  return byCode;
}

function classifyPayableByCode(code, name) {
  if (code.startsWith('02.03.') || code.startsWith('02.01.01')) {
    let l2 = 'Demais custos / CMV';
    if (code.startsWith('02.03.02')) l2 = 'Bebidas (CMV)';
    else if (code.startsWith('02.03.01')) l2 = 'Insumos e alimentos (CMV)';
    else if (code.startsWith('02.03.03')) l2 = 'Embalagens, descartáveis e gelo';
    else if (code.startsWith('02.01.01')) l2 = 'Compras e fretes';
    return { drillBucket: 'cmv', l2, l3: name, code };
  }
  if (code.startsWith('02.01.02') || code.startsWith('02.01.03')) {
    return { drillBucket: 'discounts', l2: 'Deduções de receita', l3: name, code };
  }
  if (code.startsWith('02.02.01.02') || code.startsWith('02.02.01.03')) {
    return { drillBucket: 'irpj', l2: 'IRPJ e CSLL', l3: name, code };
  }
  if (code.startsWith('02.02.01.01') || code.startsWith('02.02.01.04') || code.startsWith('02.02.01.05')) {
    // DAS / Simples Nacional / Outros tributos sobre resultado -> irpj
    return { drillBucket: 'irpj', l2: 'IRPJ / CSLL / DAS', l3: name, code };
  }
  if (code.startsWith('02.02.')) {
    return { drillBucket: 'taxes_on_sales', l2: 'Impostos sobre vendas / Simples', l3: name, code };
  }
  if (code.startsWith('03.01.')) {
    return { drillBucket: 'personnel', l2: 'Despesas com Pessoal', l3: name, code };
  }
  if (code.startsWith('03.04.')) {
    return { drillBucket: 'financial', l2: 'Despesas Financeiras', l3: name, code };
  }
  if (code.startsWith('03.03.')) {
    return { drillBucket: 'variable', l2: 'Despesas Variveis', l3: name, code };
  }
  if (code.startsWith('03.02.')) {
    return { drillBucket: 'admin', l2: 'Administrativo, ocupação e utilidades', l3: name, code };
  }
  if (code.startsWith('04.') || code.startsWith('05.')) {
    return { drillBucket: 'admin', l2: 'Investimentos e não operacional', l3: name, code };
  }
  return null;
}

function classifyPayableByLegacy(legacy, name, code) {
  const mapLegacy = {
    cmv: { l2: 'CMV (plano legado)', l3: name },
    pessoal: { l2: 'Pessoal (plano legado)', l3: name },
    financeiras: { l2: 'Financeiras (plano legado)', l3: name },
    irpj: { l2: 'IRPJ / CSLL (plano legado)', l3: name },
    impostos: { l2: 'Impostos (plano legado)', l3: name },
    admin: { l2: 'Despesas gerais (plano legado)', l3: name },
  };
  const b = mapLegacy[legacy] || mapLegacy.admin;
  const drillBucket =
    legacy === 'impostos' ? 'impostos_vendas' : legacy === 'irpj' ? 'irpj' : legacy;
  return { drillBucket, l2: b.l2, l3: b.l3, code: code || '—' };
}

/**
 * Receita: categorias 01.* (receita / ambos no extrato).
 * @param {{ name?: string, account_code?: string|null, type?: string|null }|null} cat
 */
function classifyRevenueCategory(cat) {
  const code = String(cat?.account_code || '').trim();
  const name = String(cat?.name || 'Sem categoria').trim() || 'Sem categoria';
  if (code.startsWith('01.01.')) {
    return { l2: 'Receita comercial (formas de pagamento / canais)', l3: name, code };
  }
  if (code.startsWith('01.02.')) {
    return { l2: 'Receitas financeiras e outras', l3: name, code };
  }
  if (code) {
    return { l2: 'Outras receitas classificadas', l3: name, code };
  }
  return { l2: 'Receita (sem código de conta)', l3: name, code: '—' };
}

function mkKey(...parts) {
  return parts.map((p) => String(p ?? '')).join('\u0001');
}

/**
 * Monta árvore L1 → L2 → L3 com valores e ids para drill.
 * @param {object} parts
 */
function buildAnalyticHierarchy({ sales, payables, bankCredits, totals }) {
  const l1Map = new Map();

  function ensureL1(key, label) {
    if (!l1Map.has(key)) {
      l1Map.set(key, {
        dre_line_key: key,
        level: 1,
        label: label,
        amount: 0,
        l2Map: new Map(),
      });
    }
    return l1Map.get(key);
  }
  function ensureL2(l1, l2Key, l2Label) {
    if (!l1.l2Map.has(l2Key)) {
      l1.l2Map.set(l2Key, {
        key: l2Key,
        level: 2,
        label: l2Label,
        amount: 0,
        l3Map: new Map(),
      });
    }
    return l1.l2Map.get(l2Key);
  }
  function addL3(l1Key, l1Label, l2Key, l2Label, l3Key, l3Label, amount, drillBucket, categoryId) {
    if (!amount || Math.abs(amount) < 0.0001) return;
    const l1 = ensureL1(l1Key, l1Label);
    l1.amount += amount;
    const l2 = ensureL2(l1, l2Key, l2Label);
    l2.amount += amount;
    const k3 = mkKey(l3Key, categoryId || '');
    if (!l2.l3Map.has(k3)) {
      l2.l3Map.set(k3, {
        key: l3Key,
        level: 3,
        label: l3Label,
        amount: 0,
        drill_bucket: drillBucket,
        category_id: categoryId || null,
      });
    }
    const n3 = l2.l3Map.get(k3);
    n3.amount += amount;
  }

  const L1 = {
    gross_revenue: '1. Receita Bruta de Vendas',
    discounts: '(-) Deduções / devoluções / cancelamentos',
    taxes_on_sales: '(-) Impostos sobre vendas',
    net_revenue: '2. Receita Líquida',
    cmv: '(-) CMV / Custos sobre vendas',
    gross_profit: '3. Lucro Bruto',
    personnel: '(-) Despesas com Pessoal',
    admin_expenses: '(-) Despesas administrativas e operacionais',
    depreciation: '(-) Depreciação (estimada)',
    ebitda: '4. EBITDA',
    financial_exp: '(-) Despesas Financeiras',
    lair: '5. LAIR',
    irpj: '(-) IRPJ / CSLL',
    net_profit: '6. Lucro Líquido',
  };

  for (const s of sales || []) {
    const g0 = parseFloat(s.gross_value) || 0;
    const n0 = parseFloat(s.net_value) || 0;
    const g = Math.abs(g0) > 1e-9 ? g0 : n0;
    if (!g) continue;
    const cat = s.categories || null;
    const { l2, l3 } = classifyRevenueCategory(cat);
    addL3('gross_revenue', L1.gross_revenue, 'recv_vendas', l2, l3, l3, g, 'receita_bruta', cat?.id || s.category_id);
  }
  for (const b of bankCredits || []) {
    const g = parseFloat(b.amount) || 0;
    if (!g) continue;
    const cat = b.categories || null;
    const { l2, l3 } = classifyRevenueCategory(cat);
    addL3('gross_revenue', L1.gross_revenue, 'recv_extrato', l2, l3, l3, g, 'receita_bruta', cat?.id || b.category_id);
  }

  for (const p of payables || []) {
    const amt = parseFloat(p.amount) || 0;
    if (!amt) continue;
    const cat = p.categories || null;
    const { drillBucket, l2, l3 } = classifyPayableForDre(cat);
    const cid = cat?.id || p.category_id;
    if (drillBucket === 'devolucoes') {
      addL3('discounts', L1.discounts, 'ded_pay', l2, l3, l3, amt, 'devolucoes', cid);
    } else if (drillBucket === 'impostos_vendas') {
      addL3('taxes_on_sales', L1.taxes_on_sales, 'imp', l2, l3, l3, amt, 'impostos_vendas', cid);
    } else if (drillBucket === 'irpj') {
      addL3('irpj', L1.irpj, 'ir', l2, l3, l3, amt, 'irpj', cid);
    } else if (drillBucket === 'cmv') {
      addL3('cmv', L1.cmv, mkKey('cmv', l2), l2, l3, l3, amt, 'cmv', cid);
    } else if (drillBucket === 'pessoal') {
      addL3('personnel', L1.personnel, mkKey('pes', l2), l2, l3, l3, amt, 'pessoal', cid);
    } else if (drillBucket === 'financeiras') {
      addL3('financial_exp', L1.financial_exp, mkKey('fin', l2), l2, l3, l3, amt, 'financeiras', cid);
    } else {
      addL3('admin_expenses', L1.admin_expenses, mkKey('adm', l2), l2, l3, l3, amt, 'admin', cid);
    }
  }

  for (const s of sales || []) {
    const disc = parseFloat(s.discount) || 0;
    if (!disc) continue;
    const cat = s.categories || null;
    const lab = cat?.name ? `Descontos · ${cat.name}` : 'Descontos na venda';
    addL3('discounts', L1.discounts, 'ded_vendas', 'Descontos em vendas importadas', lab, lab, disc, 'devolucoes', cat?.id || s.category_id);
  }

  const bridge = ['net_revenue', 'gross_profit', 'ebitda', 'lair', 'net_profit', 'depreciation'];
  for (const k of bridge) {
    if (totals[k] != null) {
      const node = ensureL1(k, L1[k] || k);
      node.amount = Number(totals[k]) || 0;
      node.is_bridge = true;
    }
  }

  const syncKeys = ['gross_revenue', 'discounts', 'taxes_on_sales', 'cmv', 'personnel', 'admin_expenses', 'financial_exp', 'irpj'];
  for (const k of syncKeys) {
    if (l1Map.has(k) && totals && totals[k] != null && !l1Map.get(k).is_bridge) {
      l1Map.get(k).amount = Number(totals[k]) || 0;
    }
  }

  function serialize(l1) {
    const amt1 =
      totals && totals[l1.dre_line_key] != null && Number.isFinite(Number(totals[l1.dre_line_key]))
        ? Math.round(Number(totals[l1.dre_line_key]) * 100) / 100
        : Math.round(l1.amount * 100) / 100;
    if (l1.is_bridge) {
      return {
        dre_line_key: l1.dre_line_key,
        level: 1,
        label: l1.label,
        amount: amt1,
        is_bridge: true,
        drill_bucket: null,
        children: [],
      };
    }
    const parentDrill = inferL1Drill(l1.dre_line_key);
    const l2Children = [...l1.l2Map.values()].map((l2) => ({
      key: l2.key,
      level: 2,
      label: l2.label,
      amount: Math.round(l2.amount * 100) / 100,
      drill_bucket: parentDrill,
      children: [...l2.l3Map.values()]
        .map((l3) => ({
          key: l3.key,
          level: 3,
          label: l3.label,
          amount: Math.round(l3.amount * 100) / 100,
          drill_bucket: l3.drill_bucket,
          category_id: l3.category_id,
        }))
        .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
    }));
    return {
      dre_line_key: l1.dre_line_key,
      level: 1,
      label: l1.label,
      amount: amt1,
      is_bridge: false,
      drill_bucket: parentDrill,
      children: l2Children.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
    };
  }

  function inferL1Drill(k) {
    const m = {
      gross_revenue: 'receita_bruta',
      discounts: 'devolucoes',
      taxes_on_sales: 'impostos_vendas',
      cmv: 'cmv',
      personnel: 'pessoal',
      admin_expenses: 'admin',
      financial_exp: 'financeiras',
      irpj: 'irpj',
    };
    return m[k] || null;
  }

  const order = [
    'gross_revenue',
    'discounts',
    'taxes_on_sales',
    'net_revenue',
    'cmv',
    'gross_profit',
    'personnel',
    'admin_expenses',
    'depreciation',
    'ebitda',
    'financial_exp',
    'lair',
    'irpj',
    'net_profit',
  ];

  const bridgeKeySet = new Set(bridge);
  for (const k of order) {
    if (totals && totals[k] != null && !l1Map.has(k)) {
      const n = ensureL1(k, L1[k] || k);
      n.amount = Number(totals[k]) || 0;
      n.is_bridge = bridgeKeySet.has(k);
    }
  }

  return order
    .filter((k) => l1Map.has(k))
    .map((k) => serialize(l1Map.get(k)));
}

module.exports = {
  classifyPayableForDre,
  classifyRevenueCategory,
  buildAnalyticHierarchy,
};
