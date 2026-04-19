const {
  cleanCategoryId,
  categoryIdIfAllowed,
  pickFallbackExpenseCategoryId,
  pickFallbackRevenueCategoryId,
  payableCategoryIdOrFallback,
} = require('../categoryIdSafe');

const uuid = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

describe('cleanCategoryId', () => {
  test('aceita UUID válido', () => {
    expect(cleanCategoryId(uuid)).toBe(uuid);
  });

  test('rejeita string inválida', () => {
    expect(cleanCategoryId('not-a-uuid')).toBeNull();
    expect(cleanCategoryId('')).toBeNull();
    expect(cleanCategoryId('undefined')).toBeNull();
  });
});

describe('categoryIdIfAllowed', () => {
  const list = [{ id: uuid }, { id: 'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' }];

  test('só retorna id se estiver na lista', () => {
    expect(categoryIdIfAllowed(uuid, list)).toBe(uuid);
    expect(categoryIdIfAllowed('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', list)).toBeNull();
  });
});

describe('pickFallbackExpenseCategoryId', () => {
  test('prefere Frios/embutidos antes de Compras e fretes genérico', () => {
    const cats = [
      { id: '10000000-0000-4000-8000-000000000001', name: 'Compras e fretes', type: 'despesa' },
      { id: '20000000-0000-4000-8000-000000000002', name: 'Frios e Embutidos', type: 'despesa' },
    ];
    expect(pickFallbackExpenseCategoryId(cats)).toBe('20000000-0000-4000-8000-000000000002');
  });
});

describe('pickFallbackRevenueCategoryId', () => {
  test('escolhe receita quando há nome típico', () => {
    const cats = [
      { id: '30000000-0000-4000-8000-000000000003', name: 'Vendas à vista', type: 'receita' },
      { id: '40000000-0000-4000-8000-000000000004', name: 'CMV', type: 'despesa' },
    ];
    expect(pickFallbackRevenueCategoryId(cats)).toBe('30000000-0000-4000-8000-000000000003');
  });
});

describe('payableCategoryIdOrFallback', () => {
  test('usa fallback quando id inválido', () => {
    const cats = [{ id: uuid, name: 'Outros', type: 'despesa' }];
    expect(payableCategoryIdOrFallback('x', cats)).toBe(uuid);
  });
});
