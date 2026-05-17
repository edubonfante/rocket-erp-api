const ExcelJS = require('exceljs');
const { buildDreXlsxBuffer } = require('../dreXlsxBuffer');

const expectDisplayFont = (cell, extra = {}) => {
  expect(cell.font).toMatchObject({ name: 'Syne', bold: true, ...extra });
};

describe('buildDreXlsxBuffer', () => {
  test('aplica fonte de display Syne em títulos e cabeçalhos', async () => {
    const buffer = await buildDreXlsxBuffer(
      {
        gross_revenue: 1000,
        discounts: 100,
        taxes_on_sales: 50,
        net_revenue: 850,
        cmv: 350,
        gross_profit: 500,
        personnel: 120,
        admin_expenses: 90,
        depreciation: 25,
        ebitda: 265,
        financial_exp: 40,
        lair: 225,
        irpj: 40,
        net_profit: 185,
        gross_margin: 58.82,
        ebitda_margin: 31.18,
        net_margin: 21.76,
        expenses_detail: [{ name: 'Marketing', amount: 40, pct: 4.71 }],
        multi_month: {
          month_keys: ['2026-01', '2026-02'],
          month_labels: { '2026-01': 'Jan/26', '2026-02': 'Fev/26' },
          rows: [
            {
              key: 'net_revenue',
              label: '2. Receita Líquida',
              by_month: { '2026-01': 400, '2026-02': 450 },
              total: 850,
              average: 425,
            },
            {
              key: 'gross_profit',
              label: '3. Lucro Bruto',
              by_month: { '2026-01': 220, '2026-02': 280 },
              total: 500,
              average: 250,
            },
            {
              key: 'ebitda',
              label: '4. EBITDA',
              by_month: { '2026-01': 120, '2026-02': 145 },
              total: 265,
              average: 132.5,
            },
            {
              key: 'net_profit',
              label: '6. Lucro Líquido',
              by_month: { '2026-01': 90, '2026-02': 95 },
              total: 185,
              average: 92.5,
            },
          ],
          horizontal: [
            {
              metric_label: 'Receita líquida',
              from_month: '2026-01',
              to_month: '2026-02',
              from_value: 400,
              to_value: 450,
              pct_change: 12.5,
            },
          ],
          vertical: [
            {
              month_label: 'Jan/26',
              net_revenue: 400,
              lines: [{ label: 'CMV', value: 170, pct_of_net_revenue: 42.5 }],
            },
          ],
        },
      },
      '2026-01-01',
      '2026-02-28',
    );

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);

    const consolidated = wb.getWorksheet('DRE consolidado');
    expectDisplayFont(consolidated.getCell('A1'), { size: 16 });
    expectDisplayFont(consolidated.getCell('A2'));
    expectDisplayFont(consolidated.getCell('A4'));
    expectDisplayFont(consolidated.getCell('A20'));

    const byCategory = wb.getWorksheet('Despesas por categoria');
    expectDisplayFont(byCategory.getCell('A1'));

    const monthly = wb.getWorksheet('DRE por mês');
    expectDisplayFont(monthly.getCell('A1'));

    const horizontal = wb.getWorksheet('Análise horizontal');
    expectDisplayFont(horizontal.getCell('A1'));

    const vertical = wb.getWorksheet('Análise vertical');
    expectDisplayFont(vertical.getCell('A1'));
    expectDisplayFont(vertical.getCell('A2'));
  });
});
