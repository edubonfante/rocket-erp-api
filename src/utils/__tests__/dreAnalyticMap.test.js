const { classifyPayableForDre } = require('../dreAnalyticMap');

describe('classifyPayableForDre', () => {
  test('02.03.x → cmv', () => {
    const r = classifyPayableForDre({ account_code: '02.03.01.01', name: 'Insumo X' });
    expect(r.drillBucket).toBe('cmv');
  });

  test('02.01.01 → cmv / compras e fretes', () => {
    const r = classifyPayableForDre({ account_code: '02.01.01.02', name: 'Frete' });
    expect(r.drillBucket).toBe('cmv');
    expect(r.l2).toMatch(/Compras/i);
  });

  test('02.02.x → impostos_vendas', () => {
    const r = classifyPayableForDre({ account_code: '02.02.01.01', name: 'Simples' });
    expect(r.drillBucket).toBe('impostos_vendas');
  });

  test('03.01.x → pessoal', () => {
    const r = classifyPayableForDre({ account_code: '03.01.01.01', name: 'Salários' });
    expect(r.drillBucket).toBe('pessoal');
  });
});
