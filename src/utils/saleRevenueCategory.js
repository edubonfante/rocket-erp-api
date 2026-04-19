const { matchCompanyCategoryId } = require('./categoryMatch');
const { categoryIdIfAllowed, pickFallbackRevenueCategoryId } = require('./categoryIdSafe');

/**
 * Monta um rótulo alinhado ao plano de contas de receita (ex.: "Receita comercial - PIX")
 * a partir do payment_method e do texto bruto da linha.
 */
function buildRevenueCategoryHint(row) {
  const rd = row && row.raw_data && typeof row.raw_data === 'object' ? row.raw_data : {};
  const fromModel = rd.revenue_category || rd.revenue_category_hint;
  if (fromModel && String(fromModel).trim()) return String(fromModel).trim().slice(0, 200);

  const raw = JSON.stringify(rd).toLowerCase();
  if (/ifood|i\s*food/.test(raw)) return 'Receita comercial - iFood';
  if (/rappi/.test(raw)) return 'Receita comercial - Rappi';
  if (/uber\s*eats|ubereats/.test(raw)) return 'Receita comercial - Uber Eats';
  if (/alelo/.test(raw)) return 'Receita comercial - Alelo';
  if (/\bben\b|benvis|ben\s+vale/.test(raw)) return 'Receita comercial - Ben';
  if (/sodexo/.test(raw)) return 'Receita comercial - Sodexo';
  if (/ticket\s+alim|ticket\s+rest|\.ticket\./.test(raw)) return 'Receita comercial - Ticket';
  if (/\bvr\b|vale\s+refei|good\s*card/.test(raw)) return 'Receita comercial - VR';
  if (/\belo\b/.test(raw)) return 'Receita comercial - Elo';
  if (/master|mastercard/.test(raw)) return 'Receita comercial - Mastercard';
  if (/\bvisa\b/.test(raw)) return 'Receita comercial - Visa';
  if (/hiper(card)?/.test(raw)) return 'Receita comercial - Hipercard';
  if (/cheque|check/.test(raw)) return 'Receita comercial - Cheque';
  if (/boleto/.test(raw)) return 'Receita comercial - Boletos';
  if (/rendimento|aplica[cç][aã]o|cdb|lci|lca/.test(raw)) return 'Rendimentos de aplicações';

  const pm = String(row.payment_method || '').toLowerCase();
  switch (pm) {
    case 'pix':
      return 'Receita comercial - PIX';
    case 'dinheiro':
      return 'Receita comercial - Dinheiro';
    case 'credito':
      return 'Receita comercial - Cartão de crédito';
    case 'debito':
      return 'Receita comercial - Cartão de débito';
    case 'boleto':
      return 'Receita comercial - Boletos';
    case 'transferencia':
      return 'Receita comercial - Transferência';
    case 'voucher':
      return 'Receita comercial - Ticket';
    case 'cupom':
      return 'Receita comercial - À vista';
    default:
      return 'Outras receitas financeiras';
  }
}

/**
 * @param {object} row linha normalizada de venda
 * @param {Array<{id:string,name:string,type?:string}>} catList categorias da empresa + globais
 * @returns {string|null} category_id
 */
function resolveSaleCategoryId(row, catList) {
  if (!Array.isArray(catList) || !catList.length) return null;
  const hint = buildRevenueCategoryHint(row);
  const prefer = ['receita', 'ambos'];
  const id = categoryIdIfAllowed(
    matchCompanyCategoryId(catList, hint, { preferTypes: prefer }),
    catList,
  );
  if (id) return id;
  return pickFallbackRevenueCategoryId(catList);
}

module.exports = { buildRevenueCategoryHint, resolveSaleCategoryId };
