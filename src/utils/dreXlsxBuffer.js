const ExcelJS = require('exceljs');

const fmt = (v) => Math.round((v || 0) * 100) / 100;

/**
 * Gera workbook .xlsx da DRE (ExcelJS — só escrita, uso no servidor).
 * Com `d.multi_month`, adiciona abas por mês + análises.
 */
async function buildDreXlsxBuffer(d, dateFrom, dateTo) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Rocket ERP';

  const ws = wb.addWorksheet('DRE consolidado', { views: [{ state: 'frozen', ySplit: 4 }] });
  ws.addRow(['DRE — Demonstração do Resultado (período consolidado)']);
  ws.addRow(['Período', String(dateFrom || ''), String(dateTo || '')]);
  ws.addRow([]);
  ws.addRow(['Linha', 'Valor (R$)']);
  const lines = [
    ['1. Receita Bruta de Vendas', d.gross_revenue],
    ['(-) Devoluções / Cancelamentos', d.discounts],
    ['(-) Impostos s/ Vendas', d.taxes_on_sales],
    ['2. Receita Líquida', d.net_revenue],
    ['(-) CMV', d.cmv],
    ['3. Lucro Bruto', d.gross_profit],
    ['(-) Despesas com Pessoal', d.personnel],
    ['(-) Despesas Gerais / Admin', d.admin_expenses],
    ['(-) Depreciação', d.depreciation],
    ['4. EBITDA', d.ebitda],
    ['(-) Despesas Financeiras', d.financial_exp],
    ['5. LAIR', d.lair],
    ['(-) IRPJ / CSLL', d.irpj],
    ['6. Lucro Líquido', d.net_profit],
  ];
  for (const row of lines) ws.addRow(row);
  ws.addRow([]);
  ws.addRow(['% s/ receita líquida', '']);
  ws.addRow(['Margem bruta (%)', d.gross_margin]);
  ws.addRow(['Margem EBITDA (%)', d.ebitda_margin]);
  ws.addRow(['Margem líquida (%)', d.net_margin]);

  ws.getColumn(1).width = 42;
  ws.getColumn(2).width = 18;
  for (let r = 5; r <= ws.rowCount; r++) {
    const cell = ws.getCell(r, 2);
    if (typeof cell.value === 'number') cell.numFmt = '#,##0.00';
  }

  const det = d.expenses_detail || [];
  if (det.length) {
    const ws2 = wb.addWorksheet('Despesas por categoria');
    ws2.addRow(['Categoria', 'Valor (R$)', '% receita líq.']);
    for (const e of det) {
      ws2.addRow([e.name, Number(e.amount) || 0, Number(e.pct) || 0]);
    }
    ws2.getColumn(1).width = 36;
    ws2.getColumn(2).width = 16;
    ws2.getColumn(3).width = 16;
    for (let r = 2; r <= ws2.rowCount; r++) {
      ws2.getCell(r, 2).numFmt = '#,##0.00';
      ws2.getCell(r, 3).numFmt = '0.00';
    }
  }

  const mm = d.multi_month;
  if (mm && mm.month_keys?.length && mm.rows?.length) {
    const keys = mm.month_keys;
    const wsm = wb.addWorksheet('DRE por mês', { views: [{ state: 'frozen', xSplit: 1, ySplit: 2 }] });
    const head = ['Linha', ...keys.map((k) => mm.month_labels[k] || k), 'Total período', 'Média mensal'];
    wsm.addRow(head);
    for (const row of mm.rows) {
      const cells = [
        row.label,
        ...keys.map((k) => Number(row.by_month[k]) || 0),
        Number(row.total) || 0,
        Number(row.average) || 0,
      ];
      wsm.addRow(cells);
    }
    wsm.getColumn(1).width = 40;
    for (let c = 2; c <= head.length; c++) {
      wsm.getColumn(c).width = 14;
      for (let r = 2; r <= wsm.rowCount; r++) {
        wsm.getCell(r, c).numFmt = '#,##0.00';
      }
    }

    const rowByKey = Object.fromEntries(mm.rows.map((r) => [r.key, r]));
    const nr = rowByKey.net_revenue;
    const addPct = (label, numKey) => {
      if (!nr || !rowByKey[numKey]) return;
      const cells = [
        label,
        ...keys.map((k) => {
          const den = Number(nr.by_month[k]) || 0;
          const num = Number(rowByKey[numKey].by_month[k]) || 0;
          return den > 0 ? fmt((num / den) * 100) : null;
        }),
        numKey === 'gross_profit'
          ? Number(d.gross_margin) || 0
          : numKey === 'ebitda'
            ? Number(d.ebitda_margin) || 0
            : numKey === 'net_profit'
              ? Number(d.net_margin) || 0
              : null,
        fmt(
          keys.reduce((s, k) => {
            const den = Number(nr.by_month[k]) || 0;
            const num = Number(rowByKey[numKey].by_month[k]) || 0;
            return s + (den > 0 ? (num / den) * 100 : 0);
          }, 0) / keys.length,
        ),
      ];
      wsm.addRow(cells);
    };
    wsm.addRow([]);
    addPct('Margem bruta (% s/ rec. líq.)', 'gross_profit');
    addPct('Margem EBITDA (% s/ rec. líq.)', 'ebitda');
    addPct('Margem líquida (% s/ rec. líq.)', 'net_profit');
    for (let r = wsm.rowCount - 2; r <= wsm.rowCount; r++) {
      for (let c = 2; c <= head.length; c++) {
        const cell = wsm.getCell(r, c);
        if (typeof cell.value === 'number') cell.numFmt = '0.00';
      }
    }

    const wsh = wb.addWorksheet('Análise horizontal');
    wsh.addRow(['Métrica', 'De', 'Para', 'Valor anterior', 'Valor atual', 'Variação %']);
    for (const h of mm.horizontal || []) {
      wsh.addRow([
        h.metric_label,
        mm.month_labels[h.from_month] || h.from_month,
        mm.month_labels[h.to_month] || h.to_month,
        h.from_value,
        h.to_value,
        h.pct_change == null ? '—' : h.pct_change,
      ]);
    }
    wsh.getColumn(1).width = 36;
    wsh.getColumn(2).width = 12;
    wsh.getColumn(3).width = 12;
    wsh.getColumn(4).width = 16;
    wsh.getColumn(5).width = 16;
    wsh.getColumn(6).width = 14;

    const wsv = wb.addWorksheet('Análise vertical');
    for (const block of mm.vertical || []) {
      wsv.addRow([
        `% sobre receita líquida — ${block.month_label} (receita líquida do mês: R$ ${block.net_revenue})`,
      ]);
      wsv.addRow(['Linha', 'Valor R$', '% rec. líquida']);
      for (const ln of block.lines || []) {
        wsv.addRow([ln.label, ln.value, ln.pct_of_net_revenue == null ? '—' : ln.pct_of_net_revenue]);
      }
      wsv.addRow([]);
    }
    wsv.getColumn(1).width = 38;
    wsv.getColumn(2).width = 16;
    wsv.getColumn(3).width = 16;
    for (let r = 1; r <= wsv.rowCount; r++) {
      const v = wsv.getCell(r, 2).value;
      if (typeof v === 'number') wsv.getCell(r, 2).numFmt = '#,##0.00';
      const v3 = wsv.getCell(r, 3).value;
      if (typeof v3 === 'number') wsv.getCell(r, 3).numFmt = '0.00';
    }
  }

  return wb.xlsx.writeBuffer();
}

module.exports = { buildDreXlsxBuffer };
