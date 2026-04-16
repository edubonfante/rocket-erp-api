/**
 * Heurísticas simples para classificar lançamentos de extrato (antes / além do Gemini).
 * Retorna um rótulo próximo dos nomes do seed Rocket para o matchCompanyCategoryId casar.
 */

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** @returns {string|null} rótulo sugerido */
function bankCategoryHint(description, amount) {
  const d = norm(description);
  if (!d || d === 'movimentacao') return null;

  const outRules = [
    { re: /salari|folha pag|folha de|funcionari|clt|rescis|ferias pag/, hint: 'Salários' },
    { re: /pro[- ]?labore|prolabore/, hint: 'Pró-labore' },
    { re: /fgts|inss|previd|darf.*prev|gps/, hint: 'FGTS / INSS' },
    { re: /simples|darf|gps|imposto|tribut|federal|prefeit|iss |iptu|itbi|iof/, hint: 'Impostos / Taxas' },
    { re: /energia|eletric|luz |cemig|cpfl|enel|light|copel|equatorial/, hint: 'Energia Elétrica' },
    { re: /\bagua\b|sabesp|cedae|copasa|sanepar/, hint: 'Água' },
    { re: /internet|telefon|vivo|claro|tim |oi fibra|netflix|spotify|assinatura/, hint: 'Internet / Telefone' },
    { re: /aluguel|locacao de imovel|condominio/, hint: 'Aluguel' },
    { re: /combust|posto shell|posto ipiranga|petrobras|etanol|gasolina/, hint: 'Combustível' },
    { re: /tarifa|taxa banc|cesta de|manutencao conta|iof operac/, hint: 'Despesas Financeiras' },
    { re: /marketing|google ads|facebook ads|meta ads|publicidade/, hint: 'Marketing / Publicidade' },
    { re: /manutencao|conserto|peca|oficina/, hint: 'Manutenção' },
    { re: /supermercado|atacad(o|ista)|mercadoria|distribuidor|fornecedor.*(nf|nota|boleto)/, hint: 'Compras de Mercadoria' },
    { re: /boleto\s+(pag|pago)|transferencia\s+enviad|pix\s+enviad|ted\s+enviad|doc\s+pag/, hint: 'Compras de Mercadoria' },
  ];

  const inRules = [
    { re: /pix receb|ted receb|doc receb|transferencia receb|credito em conta|deposito/, hint: 'Vendas à Vista' },
    { re: /venda|recebimento cliente|nfce|cupom fiscal/, hint: 'Vendas à Vista' },
    { re: /juros receb|rendimento cdb|dividend/, hint: 'Juros Recebidos' },
    { re: /servico prest|nota fiscal de servico.*tomador/, hint: 'Serviços Prestados' },
  ];

  const rules = amount < 0 ? outRules : inRules;
  for (const { re, hint } of rules) {
    if (re.test(d)) return hint;
  }
  return null;
}

module.exports = { bankCategoryHint, norm };
