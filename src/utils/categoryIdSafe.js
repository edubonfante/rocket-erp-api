const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Normaliza UUID vindo do cliente (evita "" e strings inválidas no Postgres). */
function cleanCategoryId(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === 'undefined' || s === 'null') return null;
  return UUID_RE.test(s) ? s : null;
}

/**
 * Só devolve o id se existir na lista carregada do banco (evita FK "categoria não encontrada").
 * @param {string|null|undefined} id
 * @param {Array<{id:string}>} catList
 */
function categoryIdIfAllowed(id, catList) {
  const c = cleanCategoryId(id);
  if (!c || !Array.isArray(catList) || !catList.length) return null;
  const cl = c.toLowerCase();
  return catList.some((row) => row && String(row.id).toLowerCase() === cl) ? c : null;
}

function isExpenseLikeType(t) {
  return t == null || t === 'despesa' || t === 'ambos';
}

function isRevenueLikeType(t) {
  return t == null || t === 'receita' || t === 'ambos';
}

/** Fallback para vendas: receita genérica do plano. */
function pickFallbackRevenueCategoryId(catList) {
  if (!Array.isArray(catList) || !catList.length) return null;
  const rows = catList.filter((c) => c && c.id && isRevenueLikeType(c.type));
  if (!rows.length) return null;
  const by = (re) => rows.find((c) => re.test(String(c.name || '')));
  return (
    by(/outras receitas financeiras/i)?.id
    || by(/vendas à vista|vendas a prazo/i)?.id
    || by(/^outros$/i)?.id
    || rows[0].id
  );
}

/**
 * Última opção para payables: evita category_id null quando o banco exige FK / NOT NULL.
 * Prefere nomes típicos de mercadoria/compras, senão primeira categoria de despesa/ambos.
 */
function pickFallbackExpenseCategoryId(catList) {
  if (!Array.isArray(catList) || !catList.length) return null;
  const rows = catList.filter((c) => c && c.id && isExpenseLikeType(c.type));
  if (!rows.length) {
    const any = catList.find((c) => c && c.id);
    return any ? any.id : null;
  }
  const by = (re) => rows.find((c) => re.test(String(c.name || '')));
  /* Preferir “Outros” e rubricas de mercadoria/CMV antes de “Compras e fretes” genérico. */
  return (
    by(/^outros$/i)?.id
    || by(/diversos|outros\s+custos/i)?.id
    || by(/frios|embutidos|hortifruti|padaria|bebidas|secos|charcut/i)?.id
    || by(/compras de mercadoria/i)?.id
    || by(/mercadoria|mat[eé]ria[-\s]?prima|despesa operacional|insumo|cmv/i)?.id
    || by(/compras\s+e\s+fretes|compras\s+e\s+frete/i)?.id
    || by(/frete e transporte|transportadora/i)?.id
    || rows[0].id
  );
}

/** category_id seguro para INSERT em payables (nunca null se existir qualquer categoria). */
function payableCategoryIdOrFallback(id, catList) {
  const v = categoryIdIfAllowed(id, catList);
  if (v) return v;
  return pickFallbackExpenseCategoryId(catList);
}

module.exports = {
  cleanCategoryId,
  categoryIdIfAllowed,
  UUID_RE,
  pickFallbackExpenseCategoryId,
  pickFallbackRevenueCategoryId,
  payableCategoryIdOrFallback,
};
