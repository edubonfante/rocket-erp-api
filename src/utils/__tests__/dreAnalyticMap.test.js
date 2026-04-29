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

  test('prioriza nome quando account_code está defasado após reorganização no Kanban', () => {
    const r = classifyPayableForDre({
      account_code: '02.03.01.01',
      name: 'Salários e encargos',
    });
    expect(r.drillBucket).toBe('pessoal');
    expect(r.l2).toMatch(/Pessoal/i);
  });

  test('mantém account_code quando nome é genérico (sem sinal forte)', () => {
    const r = classifyPayableForDre({
      account_code: '03.04.02.01',
      name: 'Despesa operacional',
    });
    expect(r.drillBucket).toBe('financeiras');
  });
});
