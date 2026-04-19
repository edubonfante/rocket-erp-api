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
    { re: /fgts|inss|previd|darf.*prev|\bgps\b(?!\s*de)/, hint: 'FGTS / INSS' },
    /* Evite “imposto” solto (corta falso positivo em textos de fornecedor). */
    {
      re: /simples nacional|\bdarf\b|\bgps\b|guias?|imposto\b|tribut(o|ação)|\biss\b|iptu|itbi|\biof\b|prefeitur|sefaz|rfb|receita federal|parcelamento|parcela impost/i,
      hint: 'Impostos / Taxas',
    },
    /* Bebidas / grandes marcas — antes de “frete” e “compras genéricas”. */
    {
      re: /\b(coca[\s\-]?cola|pepsico|pepsi\b|fanta|sprite|schweppes|guaran[aá]|kuat|dolly|ituba|sukita|ambev|heineken|brahma|skol|itaipava|petropolis|muller|red bull|monster|distribuidor(a)?\s+de\s+bebidas?|bebidas?\s+e\s*refriger|refrigerantes?\b)/i,
      hint: 'Refrigerantes bebidas água CMV mercadoria',
    },
    { re: /energia|eletric|luz |cemig|cpfl|enel|light|copel|equatorial/, hint: 'Energia Elétrica' },
    { re: /\bagua\b|sabesp|cedae|copasa|sanepar/, hint: 'Água' },
    { re: /internet|telefon|vivo|claro|tim |oi fibra|netflix|spotify|assinatura/, hint: 'Internet / Telefone' },
    { re: /aluguel|locacao de imovel|condominio/, hint: 'Aluguel' },
    { re: /combust|posto shell|posto ipiranga|petrobras|etanol|gasolina/, hint: 'Combustível' },
    { re: /tarifa|taxa banc|cesta de|manutencao conta|iof operac/, hint: 'Despesas Financeiras' },
    { re: /marketing|google ads|facebook ads|meta ads|publicidade/, hint: 'Marketing / Publicidade' },
    { re: /manutencao|conserto|peca|oficina/, hint: 'Manutenção' },
    /* Só “compras de mercadoria” com evidência de fornecimento de mercadoria — evita rotular todo PIX/boleto genérico. */
    {
      re: /supermercado|atacad(o|ista)|mercadoria|cmv|custo mercad|insumo|revenda|estoque|fornecedor.*(nf|nota fiscal|nfe|danfe)/i,
      hint: 'Compras de Mercadoria',
    },
    {
      re: /frete|transportadora|transporte|logistica|correios|sedex|jadlog|total express|rte\.?\s*rodovi|coleta|entrega|armazenagem/i,
      hint: 'Frete e transporte',
    },
  ];

  const inRules = [
    { re: /pix receb|ted receb|doc receb|transferencia receb|credito em conta|deposito/, hint: 'Vendas à Vista' },
    { re: /ifood/, hint: 'Receita comercial - iFood' },
    { re: /rappi/, hint: 'Receita comercial - Rappi' },
    { re: /uber\s*eats/, hint: 'Receita comercial - Uber Eats' },
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
