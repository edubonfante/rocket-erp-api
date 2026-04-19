const {
  coerceBankDate,
  inferSignedAmountFromBankRow,
  toBankTransactions,
  mapGeminiExtratoPayloadToTransactions,
  bankImportCompletenessWarning,
  estimateBankFileDataRows,
  pickBankDescriptionFromRow,
} = require('../bankImportHelpers');

describe('coerceBankDate', () => {
  test('ISO YYYY-MM-DD', () => {
    expect(coerceBankDate('2026-04-01')).toBe('2026-04-01');
  });

  test('DD/MM/YYYY', () => {
    expect(coerceBankDate('15/03/2026')).toBe('2026-03-15');
  });
});

describe('inferSignedAmountFromBankRow', () => {
  test('valor positivo + D/C débito → negativo', () => {
    const r = {
      raw_data: { Valor: '1.234,56', 'D/C': 'D', Data: '2026-01-01' },
    };
    expect(inferSignedAmountFromBankRow(r)).toBe(-1234.56);
  });

  test('valor positivo + crédito → positivo', () => {
    const r = {
      raw_data: { valor: '100,00', DC: 'C' },
    };
    expect(inferSignedAmountFromBankRow(r)).toBe(100);
  });

  test('número explícito no raw tem prioridade', () => {
    const r = { raw_data: { amount: -50.25, Valor: '999' } };
    expect(inferSignedAmountFromBankRow(r)).toBe(-50.25);
  });
});

describe('toBankTransactions', () => {
  test('usa net_value quando inferência falha', () => {
    const rows = [
      {
        sale_date: '2026-02-01',
        gross_value: 0,
        net_value: -42.5,
        payment_method: 'credito',
        raw_data: { desc: 'Pix' },
      },
    ];
    const tx = toBankTransactions(rows);
    expect(tx).toHaveLength(1);
    expect(tx[0].amount).toBe(-42.5);
  });

  test('filtra amount zero', () => {
    const rows = [
      { sale_date: '2026-02-01', gross_value: 0, net_value: 0, payment_method: 'credito', raw_data: {} },
    ];
    expect(toBankTransactions(rows)).toHaveLength(0);
  });
});

describe('mapGeminiExtratoPayloadToTransactions', () => {
  test('mapeia lista do Gemini', () => {
    const data = {
      transactions: [
        { date: '2026-01-10', amount: -12.34, historico: 'TED' },
      ],
    };
    const tx = mapGeminiExtratoPayloadToTransactions(data);
    expect(tx[0].amount).toBe(-12.34);
    expect(tx[0].entry_date).toBe('2026-01-10');
  });
});

describe('bankImportCompletenessWarning', () => {
  test('null quando poucas linhas estimadas', () => {
    expect(bankImportCompletenessWarning(10, 2)).toBeNull();
  });

  test('aviso quando import muito menor que estimativa', () => {
    const w = bankImportCompletenessWarning(100, 5);
    expect(w).toBeTruthy();
    expect(String(w)).toMatch(/100/);
  });
});

describe('estimateBankFileDataRows', () => {
  test('CSV: header + linhas', () => {
    const buf = Buffer.from('Data;Valor\n2026-01-01;10\n2026-01-02;20\n', 'utf8');
    expect(estimateBankFileDataRows(buf, 'csv')).toBe(2);
  });
});

describe('pickBankDescriptionFromRow', () => {
  test('monta descrição a partir de colunas típicas', () => {
    const r = {
      raw_data: {
        Histórico: 'Pagamento fornecedor',
        Nome: 'ACME LTDA',
      },
    };
    const d = pickBankDescriptionFromRow(r);
    expect(d.toLowerCase()).toContain('acme');
  });
});
