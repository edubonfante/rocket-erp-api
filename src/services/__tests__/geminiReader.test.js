const geminiReader = require('../geminiReader');

describe('geminiReader food service scope prompts', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mockModelWithText(jsonText) {
    return {
      generateContent: jest.fn().mockResolvedValue({
        response: {
          text: () => jsonText,
        },
      }),
    };
  }

  test('readDocument inclui escopo 100% food service no prompt', async () => {
    const model = mockModelWithText('{"doc_type":"outro","total_value":0,"confidence":0.9}');
    jest.spyOn(geminiReader, 'getModel').mockReturnValue(model);

    const out = await geminiReader.readDocument(
      Buffer.from('imagem-fake'),
      'image/png',
      'nf.png',
      { expenseCategoryNames: ['CMV - Bebidas'] },
    );

    expect(out.success).toBe(true);
    const prompt = model.generateContent.mock.calls[0][0].contents[0].parts[0].text;
    expect(prompt).toContain('100% FOOD SERVICE');
  });

  test('readSalesSnippet inclui escopo 100% food service no prompt', async () => {
    const model = mockModelWithText('{"sales":[]}');
    jest.spyOn(geminiReader, 'getModel').mockReturnValue(model);

    const out = await geminiReader.readSalesSnippet('vendas.csv', 'CSV', 'data;valor');

    expect(out.success).toBe(true);
    const prompt = model.generateContent.mock.calls[0][0].contents[0].parts[0].text;
    expect(prompt).toContain('100% FOOD SERVICE');
  });

  test('readSalesWorkbook inclui escopo 100% food service no prompt', async () => {
    const model = mockModelWithText('{"sales":[]}');
    jest.spyOn(geminiReader, 'getModel').mockReturnValue(model);

    const out = await geminiReader.readSalesWorkbook('vendas.xlsx', [
      { sheetName: 'Aba 1', snippet: 'data\tvalor\n2026-01-01\t100' },
    ]);

    expect(out.success).toBe(true);
    const prompt = model.generateContent.mock.calls[0][0].contents[0].parts[0].text;
    expect(prompt).toContain('100% FOOD SERVICE');
  });

  test('suggestCategory reforça null sem evidência de food service', async () => {
    const model = mockModelWithText('{"category":null,"confidence":0.2,"reason":"texto vago"}');
    jest.spyOn(geminiReader, 'getModel').mockReturnValue(model);

    const out = await geminiReader.suggestCategory(
      'PIX TRANSFERENCIA',
      -100,
      ['CMV - Bebidas'],
      [],
    );

    expect(out.category).toBeNull();
    const prompt = model.generateContent.mock.calls[0][0].contents[0].parts[0].text;
    expect(prompt).toContain('100% FOOD SERVICE');
    expect(prompt).toContain('sem vínculo claro com food service');
  });
});
