const fmt = (v) => Math.round((v || 0) * 100) / 100;
const { classifyPayableForDre, buildAnalyticHierarchy } = require('./dreAnalyticMap');

/** Lista inclusive YYYY-MM de cada mês civil entre dateFrom e dateTo (strings ISO date). */
function enumerateMonthKeys(dateFrom, dateTo) {
  const df = String(dateFrom || '2000-01-01').slice(0, 10);
  const dt = String(dateTo || '2099-12-31').slice(0, 10);
  const a = df.slice(0, 7);
  const b = dt.slice(0, 7);
  if (a > b) return [];
  const keys = [];
  let y = parseInt(a.slice(0, 4), 10);
  let m = parseInt(a.slice(5, 7), 10);
  const endY = parseInt(b.slice(0, 4), 10);
  const endM = parseInt(b.slice(5, 7), 10);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    keys.push(key);
    if (y === endY && m === endM) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return keys;
}

function monthLabelPt(ym) {
  const months = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const y = parseInt(String(ym).slice(0, 4), 10);
  const m = parseInt(String(ym).slice(5, 7), 10) - 1;
  if (!Number.isFinite(y) || m < 0 || m > 11) return String(ym);
  return `${months[m]}/${String(y).slice(2)}`;
}

/**
 * Agrega DRE a partir de linhas já filtradas (vendas, payables, créditos banco).
 * Usa `categories.account_code` e reconcilia com semântica do `name` para evitar
 * classificação errada quando o código fica defasado após reorganização no Kanban.
 * @param {{ sale_date?: string, gross_value?: string|number, discount?: string|number, category_id?: string, categories?: { id?: string, name?: string, account_code?: string|null, type?: string|null } }[]} sales
 * @param {{ due_date?: string, amount?: string|number, category_id?: string, categories?: { id?: string, name?: string, account_code?: string|null, type?: string|null } }[]} payables
 * @param {{ entry_date?: string, amount?: string|number, category_id?: string, categories?: { id?: string, name?: string, account_code?: string|null, type?: string|null } }[]} bankCredits
 */
function aggregateDreFromData(sales, payables, bankCredits) {
  let bankCreditToRevenue = 0;
  for (const b of bankCredits || []) {
    const ty = String(b.categories?.type || '');
    if (ty === 'receita' || ty === 'ambos') bankCreditToRevenue += parseFloat(b.amount) || 0;
  }
  bankCreditToRevenue = fmt(bankCreditToRevenue);

  const grossFromSales = fmt(
    sales?.reduce((s, r) => {
      const g = parseFloat(r.gross_value);
      const n = parseFloat(r.net_value);
      const piece = (Number.isFinite(g) && Math.abs(g) > 1e-9) ? g : (Number.isFinite(n) ? n : 0);
      return s + piece;
    }, 0) || 0,
  );
  const grossRevenue = fmt(grossFromSales + bankCreditToRevenue);

  let saleDisc = 0;
  for (const r of sales || []) saleDisc += parseFloat(r.discount) || 0;
  saleDisc = fmt(saleDisc);

  const expenses = {};
  let dedPay = 0;
  let taxesPay = 0;
  let irpjPay = 0;
  let cmvSum = 0;
  let pers = 0;
  let adm = 0;
  let fin = 0;

  for (const p of payables || []) {
    const amt = parseFloat(p.amount) || 0;
    const cn = p.categories?.name || 'Outros';
    expenses[cn] = (expenses[cn] || 0) + amt;
    const { drillBucket } = classifyPayableForDre(p.categories);
    if (drillBucket === 'devolucoes') dedPay += amt;
    else if (drillBucket === 'impostos_vendas') taxesPay += amt;
    else if (drillBucket === 'irpj') irpjPay += amt;
    else if (drillBucket === 'cmv') cmvSum += amt;
    else if (drillBucket === 'pessoal') pers += amt;
    else if (drillBucket === 'financeiras') fin += amt;
    else adm += amt;
  }

  dedPay = fmt(dedPay);
  taxesPay = fmt(taxesPay);
  irpjPay = fmt(irpjPay);
  cmvSum = fmt(cmvSum);
  pers = fmt(pers);
  adm = fmt(adm);
  fin = fmt(fin);

  const discounts = fmt(saleDisc + dedPay);
  const taxes_on_sales = taxesPay;
  const netRevenue = fmt(grossRevenue - discounts - taxes_on_sales);

  let cmv = cmvSum;
  if (!cmv || cmv === 0) cmv = fmt(netRevenue > 0 ? netRevenue * 0.47 : 0);

  const grossProfit = fmt(netRevenue - cmv);
  const personnel = pers;
  const admin_expenses = adm;
  const deprec = fmt(grossProfit * 0.03);
  const ebitda = fmt(grossProfit - personnel - admin_expenses - deprec);
  const financial_exp = fmt(fin > 0 ? fin : ebitda * 0.04);
  const lair = fmt(ebitda - financial_exp);
  const irpj = fmt(irpjPay > 0 ? irpjPay : lair * 0.04);
  const netProfit = fmt(lair - irpj);
  const pct = (v) => (netRevenue > 0 ? fmt((v / netRevenue) * 100) : 0);

  return {
    gross_revenue: grossRevenue,
    discounts,
    taxes_on_sales,
    net_revenue: netRevenue,
    cmv,
    gross_profit: grossProfit,
    gross_margin: pct(grossProfit),
    personnel,
    admin_expenses,
    depreciation: deprec,
    ebitda,
    ebitda_margin: pct(ebitda),
    financial_exp,
    lair,
    irpj,
    net_profit: netProfit,
    net_margin: pct(netProfit),
    expenses_detail: Object.entries(expenses).map(([name, amount]) => ({
      name,
      amount: fmt(amount),
      pct: pct(amount),
    })),
  };
}

const DRE_ROW_KEYS = [
  { key: 'gross_revenue', label: '1. Receita Bruta de Vendas' },
  { key: 'discounts', label: '(-) Devoluções / Cancelamentos' },
  { key: 'taxes_on_sales', label: '(-) Impostos s/ Vendas' },
  { key: 'net_revenue', label: '2. Receita Líquida' },
  { key: 'cmv', label: '(-) CMV' },
  { key: 'gross_profit', label: '3. Lucro Bruto' },
  { key: 'personnel', label: '(-) Despesas com Pessoal' },
  { key: 'admin_expenses', label: '(-) Despesas Gerais / Admin' },
  { key: 'depreciation', label: '(-) Depreciação' },
  { key: 'ebitda', label: '4. EBITDA' },
  { key: 'financial_exp', label: '(-) Despesas Financeiras' },
  { key: 'lair', label: '5. LAIR' },
  { key: 'irpj', label: '(-) IRPJ / CSLL' },
  { key: 'net_profit', label: '6. Lucro Líquido' },
];

/**
 * Mesma lógica do GET /reports/:companyId/dre — usada pelo JSON e pelo export .xlsx.
 * Com mais de um mês civil no intervalo, inclui `multi_month` (colunas por mês + total + média + análises).
 */
async function computeDre(supabase, companyId, dateFrom, dateTo) {
  const df = dateFrom || '2000-01-01';
  const dt = dateTo || '2099-12-31';

  const { data: sales, error: sErr } = await supabase
    .from('sales')
    .select('sale_date, net_value, gross_value, discount, category_id, categories(id,name,account_code,type)')
    .eq('company_id', companyId)
    .eq('cancelled', false)
    .gte('sale_date', df)
    .lte('sale_date', dt);
  if (sErr) throw new Error(sErr.message);

  const { data: payables, error: pErr } = await supabase
    .from('payables')
    .select('due_date, amount, category_id, categories(id,name,account_code,type)')
    .eq('company_id', companyId)
    .in('status', ['open', 'overdue', 'paid'])
    .gte('due_date', df)
    .lte('due_date', dt);
  if (pErr) throw new Error(pErr.message);

  const { data: bankCredits, error: bcErr } = await supabase
    .from('bank_entries')
    .select('entry_date, amount, category_id, categories(id,name,account_code,type)')
    .eq('company_id', companyId)
    .eq('status', 'classified')
    .not('category_id', 'is', null)
    .gt('amount', 0)
    .gte('entry_date', df)
    .lte('entry_date', dt);
  if (bcErr) throw new Error(bcErr.message);

  const full = aggregateDreFromData(sales || [], payables || [], bankCredits || []);
  const analytic_hierarchy = buildAnalyticHierarchy({
    sales: sales || [],
    payables: payables || [],
    bankCredits: bankCredits || [],
    totals: full,
  });

  const monthKeys = enumerateMonthKeys(df, dt);
  let multi_month = null;

  if (monthKeys.length > 1) {
    const byMonth = {};
    for (const mk of monthKeys) {
      const s = (sales || []).filter((r) => String(r.sale_date || '').slice(0, 7) === mk);
      const p = (payables || []).filter((r) => String(r.due_date || '').slice(0, 7) === mk);
      const b = (bankCredits || []).filter((r) => String(r.entry_date || '').slice(0, 7) === mk);
      byMonth[mk] = aggregateDreFromData(s, p, b);
    }

    const rows = DRE_ROW_KEYS.map(({ key, label }) => {
      const by_month = {};
      let sumM = 0;
      for (const mk of monthKeys) {
        const v = Number(byMonth[mk][key]) || 0;
        by_month[mk] = v;
        sumM += v;
      }
      const total = Number(full[key]) || 0;
      const average = fmt(monthKeys.length ? sumM / monthKeys.length : 0);
      return { key, label, by_month, total, average };
    });

    /** Análise horizontal: variação % mês a mês nas principais linhas. */
    const horizontal = [];
    const hKeys = ['gross_revenue', 'net_revenue', 'gross_profit', 'ebitda', 'net_profit'];
    for (const hk of hKeys) {
      for (let i = 1; i < monthKeys.length; i += 1) {
        const prevK = monthKeys[i - 1];
        const curK = monthKeys[i];
        const a = Number(byMonth[prevK][hk]) || 0;
        const b = Number(byMonth[curK][hk]) || 0;
        const pctChg = a === 0 ? (b === 0 ? 0 : null) : fmt(((b - a) / Math.abs(a)) * 100);
        horizontal.push({
          metric_key: hk,
          metric_label: DRE_ROW_KEYS.find((r) => r.key === hk)?.label || hk,
          from_month: prevK,
          to_month: curK,
          from_value: a,
          to_value: b,
          pct_change: pctChg,
        });
      }
    }

    /** Análise vertical: % da receita líquida do mês por linha (estrutura do resultado). */
    const vertical = [];
    const vKeys = ['cmv', 'personnel', 'admin_expenses', 'ebitda', 'net_profit'];
    for (const mk of monthKeys) {
      const nr = Number(byMonth[mk].net_revenue) || 0;
      const lines = vKeys.map((k) => {
        const val = Number(byMonth[mk][k]) || 0;
        const pctOf = nr > 0 ? fmt((val / nr) * 100) : null;
        return {
          key: k,
          label: DRE_ROW_KEYS.find((r) => r.key === k)?.label || k,
          value: val,
          pct_of_net_revenue: pctOf,
        };
      });
      vertical.push({ month_key: mk, month_label: monthLabelPt(mk), net_revenue: nr, lines });
    }

    multi_month = {
      month_keys: monthKeys,
      month_labels: Object.fromEntries(monthKeys.map((k) => [k, monthLabelPt(k)])),
      rows,
      horizontal,
      vertical,
      note:
        'Cada coluna de mês recalcula a DRE só com lançamentos daquele mês. Total período = visão consolidada (linha única). Média = média aritmética dos valores mensais da linha.',
    };
  }

  return { ...full, multi_month, analytic_hierarchy: Array.isArray(analytic_hierarchy) ? analytic_hierarchy : [] };
}

module.exports = { computeDre, fmt, aggregateDreFromData, enumerateMonthKeys };
