const ExcelJS = require('exceljs');
const { buildDreXlsxBuffer } = require('../dreXlsxBuffer');

describe('buildDreXlsxBuffer', () => {
  test('aplica borda superior e inferior na stats bar da aba consolidada', async () => {
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
      },
      '2026-01-01',
      '2026-01-31',
    );

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);

    const ws = wb.getWorksheet('DRE consolidado');
    expect(ws).toBeTruthy();

    let statsRow = null;
    ws.eachRow((row) => {
      if (row.getCell(1).value === '% s/ receita líquida') statsRow = row.number;
    });

    expect(statsRow).not.toBeNull();

    const a = ws.getCell(`A${statsRow}`);
    const b = ws.getCell(`B${statsRow}`);
    expect(a.border.top.style).toBe('thin');
    expect(a.border.bottom.style).toBe('thin');
    expect(b.border.top.style).toBe('thin');
    expect(b.border.bottom.style).toBe('thin');
  });
});
