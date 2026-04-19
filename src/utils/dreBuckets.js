/**
 * Agrupa contas a pagar nas mesmas “caixas” usadas na DRE (drill-down).
 * @returns {'cmv'|'pessoal'|'impostos'|'financeiras'|'irpj'|'admin'}
 */
function payableDreBucket(catName) {
  const n = String(catName || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (/compras de mercadoria|materia\s*prima|materia-prima|cmv|mercadoria vendida|fornecedor.*mercadoria/.test(n)) {
    return 'cmv';
  }
  if (
    /salari|pessoal|pro\s*labore|prolabore|fgts|inss|folha|rescis|ferias|13\s|vale\s|transporte|refeicao|plano de saude|odont/.test(
      n,
    )
  ) {
    return 'pessoal';
  }
  if (/financeir|tarifa|juro|banco|multa|iof|spread/.test(n)) {
    return 'financeiras';
  }
  if (/(^|[^a-z])irpj|csll([^a-z]|$)/.test(n) && !/simples/.test(n)) {
    return 'irpj';
  }
  if (/imposto|simples|icms|ipi|iss|pis|cofins|das|gps|darf|tribut|federal|prefeit/.test(n)) {
    return 'impostos';
  }
  return 'admin';
}

module.exports = { payableDreBucket };
