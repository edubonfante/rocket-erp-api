const { aggregateDreFromData, enumerateMonthKeys, fmt } = require('../dreCompute');

describe('aggregateDreFromData', () => {
  test('usa net_value na receita quando gross_value é zero', () => {
    const sales = [
      { sale_date: '2026-01-10', gross_value: 0, net_value: 150.5, discount: 0, categories: { type: 'receita' } },
    ];
    const out = aggregateDreFromData(sales, [], []);
    expect(out.gross_revenue).toBe(150.5);
  });

  test('prefere gross_value quando ambos existem e gross não é zero', () => {
    const sales = [
      { sale_date: '2026-01-10', gross_value: 200, net_value: 180, discount: 0 },
    ];
    const out = aggregateDreFromData(sales, [], []);
    expect(out.gross_revenue).toBe(200);
  });

  test('soma vendas e créditos banco classificados como receita', () => {
    const sales = [{ sale_date: '2026-01-01', gross_value: 100, discount: 0 }];
    const bankCredits = [{ entry_date: '2026-01-02', amount: 25, categories: { type: 'receita' } }];
    const out = aggregateDreFromData(sales, [], bankCredits);
    expect(out.gross_revenue).toBe(125);
  });
});

describe('enumerateMonthKeys', () => {
  test('lista meses inclusive no intervalo', () => {
    expect(enumerateMonthKeys('2026-01-15', '2026-03-10')).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  test('intervalo invertido retorna vazio', () => {
    expect(enumerateMonthKeys('2026-05-01', '2026-01-01')).toEqual([]);
  });
});

describe('fmt', () => {
  test('arredonda a 2 casas (evita armadilha de float 1.005)', () => {
    expect(fmt(99.999)).toBe(100);
    expect(fmt(3.146)).toBe(3.15);
  });
});
