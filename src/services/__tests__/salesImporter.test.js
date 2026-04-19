const importer = require('../salesImporter');

describe('SalesImporter.parseMoneyBr', () => {
  test('número passa direto', () => {
    expect(importer.parseMoneyBr(12.5)).toBe(12.5);
  });

  test('formato BR com vírgula decimal', () => {
    expect(importer.parseMoneyBr('1.234,56')).toBe(1234.56);
  });

  test('formato US quando último separador é ponto', () => {
    expect(importer.parseMoneyBr('1234.56')).toBe(1234.56);
  });

  test('R$ e espaços', () => {
    expect(importer.parseMoneyBr('R$ 10,50')).toBe(10.5);
  });

  test('vazio vira zero', () => {
    expect(importer.parseMoneyBr('')).toBe(0);
    expect(importer.parseMoneyBr(null)).toBe(0);
  });
});
