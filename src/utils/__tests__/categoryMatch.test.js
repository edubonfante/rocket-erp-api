const {
  matchCompanyCategoryId,
  labelLooksLikeRetailStockLine,
  labelLooksLikeEmbutidos,
  isComprasOuFreteGenerico,
  categoryIdIsComprasOuFreteGenerico,
  docItemsSuggestRetailStock,
  normalizeLabel,
} = require('../categoryMatch');

describe('normalizeLabel / heurísticas de linha', () => {
  test('labelLooksLikeRetailStockLine detecta produto alimentar', () => {
    expect(labelLooksLikeRetailStockLine('Café 500g NCM 0901')).toBe(true);
  });

  test('labelLooksLikeEmbutidos', () => {
    expect(labelLooksLikeEmbutidos('Mortadela tipo A')).toBe(true);
  });

  test('isComprasOuFreteGenerico', () => {
    expect(isComprasOuFreteGenerico('Compras e fretes')).toBe(true);
    expect(isComprasOuFreteGenerico('Frios e Embutidos')).toBe(false);
  });
});

describe('matchCompanyCategoryId', () => {
  const idCompras = '10000000-0000-4000-8000-000000000001';
  const idFrios = '20000000-0000-4000-8000-000000000002';
  const idSecos = '30000000-0000-4000-8000-000000000003';

  const categories = [
    { id: idCompras, name: 'Compras e fretes', type: 'despesa' },
    { id: idFrios, name: 'Frios e Embutidos', type: 'despesa' },
    { id: idSecos, name: 'Secos', type: 'despesa' },
  ];

  test('linha de estoque não cai só em Compras e fretes genérico', () => {
    const label = 'NF compra presunto kg NCM 16024900';
    const hit = matchCompanyCategoryId(categories, label, { preferTypes: ['despesa', 'ambos'] });
    expect(hit).not.toBe(idCompras);
    expect([idFrios, idSecos]).toContain(hit);
  });

  test('embutidos favorece categoria com embutidos vs Secos genérico', () => {
    const label = 'Linguica calabresa 1kg';
    const hit = matchCompanyCategoryId(categories, label);
    expect(hit).toBe(idFrios);
  });

  test('categoryIdIsComprasOuFreteGenerico', () => {
    expect(categoryIdIsComprasOuFreteGenerico(categories, idCompras)).toBe(true);
    expect(categoryIdIsComprasOuFreteGenerico(categories, idFrios)).toBe(false);
  });
});

describe('docItemsSuggestRetailStock', () => {
  test('true quando item parece estoque', () => {
    const doc = { items: [{ description: 'Arroz 5kg' }] };
    expect(docItemsSuggestRetailStock(doc)).toBe(true);
  });

  test('false sem items', () => {
    expect(docItemsSuggestRetailStock({ items: [] })).toBe(false);
    expect(docItemsSuggestRetailStock(null)).toBe(false);
  });
});

describe('normalizeLabel', () => {
  test('remove acentos e pontuação', () => {
    expect(normalizeLabel('Açúcar 1 KG!!!')).toContain('acucar');
  });
});
