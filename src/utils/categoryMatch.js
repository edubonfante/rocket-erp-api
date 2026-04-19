/**
 * Faz correspondência entre rótulos vindos do Gemini (ou texto livre)
 * e categorias cadastradas no banco (nomes nunca batem 100% com o prompt fixo do modelo).
 */

function normalizeLabel(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenSet(s) {
  return new Set(normalizeLabel(s).split(/\s+/).filter((w) => w.length > 1));
}

function scoreLabels(a, b) {
  const na = normalizeLabel(a);
  const nb = normalizeLabel(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  if (na.includes(nb) || nb.includes(na)) return 85;
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  let hit = 0;
  for (const w of ta) {
    if (tb.has(w)) hit += 1;
    else for (const x of tb) if (x.includes(w) || w.includes(x)) hit += 0.75;
  }
  return Math.min(95, hit * 22);
}

/** Mapeamento do prompt Gemini de documentos → termos para casar com o plano de contas (vários sinônimos). */
const GEMINI_HINT_TO_KEYWORD = [
  ['bovinos', 'mercadoria'],
  ['aves', 'mercadoria'],
  ['suinos', 'mercadoria'],
  ['peixes', 'mercadoria'],
  /* Embutidos/charcutaria → casar com "Frios e Embutidos" no plano, não com Secos genérico */
  ['embutidos', 'frios_embutidos'],
  ['laticinios', 'mercadoria'],
  ['hortifruti', 'mercadoria'],
  ['padaria', 'mercadoria'],
  ['secos', 'mercadoria'],
  ['massas molhos temperos', 'mercadoria'],
  ['oleos azeites', 'mercadoria'],
  ['cafe sobremesas', 'mercadoria'],
  ['cervejas', 'mercadoria'],
  ['destilados', 'mercadoria'],
  ['agua refrigerantes', 'mercadoria'],
  ['energeticos', 'mercadoria'],
  ['embalagens descartaveis', 'embalagens'],
  ['gelo', 'mercadoria'],
  ['congelados', 'mercadoria'],
  ['higiene limpeza', 'mercadoria'],
  ['outros', 'outros'],
];

/** Palavras-chave extras para buscar no nome da categoria no ERP (plano novo costuma não ter "mercadoria" no nome). */
const EXTRA_KEYWORDS_FOR_HINT = {
  /* Evite "compra" solto — casa demais com "Compras e fretes" genérico. */
  mercadoria: ['mercadoria', 'insumo', 'cmv', 'custo', 'revenda', 'estoque', 'alimento', 'genero', 'genero alimenticio', 'fornecedor'],
  embalagens: ['embalagem', 'descart', 'embalagens'],
  outros: ['outros', 'diversos', 'geral'],
  frios_embutidos: [
    'frios',
    'embutidos',
    'frios e embutidos',
    'charcut',
    'presunto',
    'salame',
    'mortadela',
    'linguica',
    'defumado',
    'proteinas',
    'cmv',
  ],
};

/** Descrição/NCM típico de linha de estoque (café, alimento, bebida) — não deve cair em "Compras e fretes" só por token genérico. */
function labelLooksLikeRetailStockLine(label) {
  const t = normalizeLabel(label);
  if (!t || t.length < 3) return false;
  /* NF/NCM costumam aparecer em compra de mercadoria; não desligue o filtro “anti Compras e fretes” por isso. */
  if (/\b(servico|aluguel|energia|agua|internet|telefonia|condominio)\b/.test(t)) return false;
  if (/\b(frete|transportad|correios)\b/.test(t) && !/\b(ncm|produto|mercador|kg|\bun\b|qtd|quant|embal)\b/.test(t)) return false;
  return /\b(kg|g\b|un\b|cx\b|lt\b|produto|aliment|cafe|cafe |achocol|chocolate|chá|cha|sobremesa|arroz|feijao|acucar|oleo|leite|queijo|carne|bebida|refriger|cervej|hortifr|padaria|embalagem|descart|mortadela|presunto|salame|salsicha|embutid|linguica|lingui|defumad|bacon|ncm|nota fiscal|danfe|nfe)\b/.test(
    t,
  );
}

function labelLooksLikeEmbutidos(label) {
  const t = normalizeLabel(label);
  if (!t || t.length < 3) return false;
  return /\b(salsicha|mortadela|presunto|salame|linguica|linguia|peito de peru|fiambre|apresuntado|embutid|defumad|bacon|nugget|blanquet|calabresa|rocambole|paio|mortadel|salamin|charque|copalombo|copa lombo|pernil|toucinho|panceta|lombo canadense)\b/.test(
    t,
  );
}

function isComprasOuFreteGenerico(name) {
  return /compras e fretes|^compras$/i.test(String(name || '')) || /frete e transporte/i.test(String(name || ''));
}

/** true se o id for categoria “Compras e fretes” / frete genérico no plano. */
function categoryIdIsComprasOuFreteGenerico(categories, id) {
  if (!id || !Array.isArray(categories)) return false;
  const c = categories.find((x) => x && String(x.id) === String(id));
  return !!(c && isComprasOuFreteGenerico(c.name));
}

/** “Secos” genérico sem frios/embutidos no nome — não deve ganhar de “Frios e Embutidos” na descrição. */
function isSecosGenericoSemEmbutidos(name) {
  const n = String(name || '');
  if (!/\bsecos\b/i.test(n)) return false;
  if (/embutid|frio|charcut|defumad|lingui|presunto|salame|mortadela/i.test(n)) return false;
  return true;
}

/**
 * @param {Array<{id:string,name:string,type?:string,company_id?:string|null}>} categories
 * @param {string} label
 * @param {{ preferTypes?: string[] }} [opts]
 * @returns {string|null} id da categoria
 */
function isTaxExpenseCategoryName(name) {
  return /imposto|taxas?\b|fgts|inss\b|simples|darf|gps\b|folha|irpj|csll|contribuic|contribui|previd|receita federal|rfb|retenc/i.test(
    String(name || ''),
  );
}

/** Linha de documento / descrição que não é claramente tributo — evita casar “insumo” com categoria de imposto por token fraco. */
function labelSuggestsTaxOrPayrollLine(label) {
  const t = normalizeLabel(label);
  if (!t) return false;
  return /\b(pis|cofins|csll|irpj|iss\b|icms|ipi\b|inss|fgts|darf|gps|simples|retenc|irrf|contribuicao|tributo|imposto|taxa)\b/.test(t);
}

function bestCategoryScore(categories, label, prefer, excludeCategory) {
  let bestId = null;
  let best = 0;
  const lab = String(label || '');
  const pref = Array.isArray(prefer) ? prefer : ['despesa', 'ambos'];
  const excl = typeof excludeCategory === 'function' ? excludeCategory : null;
  for (const c of categories) {
    if (!c || !c.id) continue;
    if (c.type && pref.length && !pref.includes(c.type)) continue;
    if (excl && excl(c)) continue;
    const sc = scoreLabels(lab, c.name);
    if (sc > best) {
      best = sc;
      bestId = c.id;
    }
  }
  return { bestId, best };
}

function mapGeminiClusterToKeyword(label) {
  const hint = normalizeLabel(label);
  if (!hint) return null;
  if (labelLooksLikeEmbutidos(label)) return 'frios_embutidos';
  for (const [needle, key] of GEMINI_HINT_TO_KEYWORD) {
    const words = normalizeLabel(needle).split(/\s+/).filter(Boolean);
    if (words.length && words.every((w) => hint.includes(w))) return key;
  }
  return null;
}

/** Vários termos para tentar casar com nomes reais do plano (ex.: Hortifruti → mercadoria + hortifruti + insumo…). */
function collectMatchSearchTerms(label) {
  const hint = normalizeLabel(label);
  if (!hint) return [];
  const terms = new Set();
  terms.add(hint);
  for (const part of hint.split(/\s+/).filter((w) => w.length > 3)) terms.add(part);

  if (/\bcafe\b|cafe |achocolat|capucc|nespresso|nescaf|sobremesa|chocolate\b|\bcha\b|chá/i.test(hint)) {
    for (const t of ['alimentos', 'secos', 'padaria', 'hortifruti', 'laticinio', 'bebidas', 'sobremesa', 'chocolate']) {
      terms.add(t);
    }
  }

  if (labelLooksLikeEmbutidos(hint)) {
    for (const t of ['frios e embutidos', 'embutidos', 'frios', 'charcutaria', 'defumados']) {
      terms.add(t);
    }
  }

  for (const [needle, key] of GEMINI_HINT_TO_KEYWORD) {
    const words = normalizeLabel(needle).split(/\s+/).filter(Boolean);
    if (words.length && words.every((w) => hint.includes(w))) {
      terms.add(key);
      for (const w of words) {
        if (w.length > 3) terms.add(w);
      }
      const extras = EXTRA_KEYWORDS_FOR_HINT[key];
      if (extras) for (const e of extras) terms.add(e);
    }
  }
  return [...terms];
}

function matchCompanyCategoryId(categories, label, opts = {}) {
  const prefer = opts.preferTypes || ['despesa', 'ambos'];
  if (!label || !categories?.length) return null;

  const deemphasizeTax = opts.deemphasizeTaxExpenseCategories === true;
  const excludeTaxFn =
    deemphasizeTax && !labelSuggestsTaxOrPayrollLine(label)
      ? (c) => isTaxExpenseCategoryName(c.name)
      : typeof opts.excludeCategory === 'function'
        ? opts.excludeCategory
        : null;

  const excludeFrete =
    opts.excludeComprasFreteForStockLines !== false && labelLooksLikeRetailStockLine(label) && !labelSuggestsTaxOrPayrollLine(label)
      ? (c) => isComprasOuFreteGenerico(c.name)
      : null;

  const excludeSecosIfEmbutidos =
    labelLooksLikeEmbutidos(label) && !labelSuggestsTaxOrPayrollLine(label)
      ? (c) => isSecosGenericoSemEmbutidos(c.name)
      : null;

  const mergedExclude =
    excludeTaxFn || excludeFrete || excludeSecosIfEmbutidos
      ? (c) =>
        !!(excludeTaxFn && excludeTaxFn(c))
        || !!(excludeFrete && excludeFrete(c))
        || !!(excludeSecosIfEmbutidos && excludeSecosIfEmbutidos(c))
      : null;

  try {
    const first = bestCategoryScore(categories, label, prefer, mergedExclude);
    if (first.best >= 28) return first.bestId;

    const searchTerms = collectMatchSearchTerms(String(label));
    let bestIndirect = { bestId: null, best: 0 };
    for (const term of searchTerms) {
      const hit = bestCategoryScore(categories, term, prefer, mergedExclude);
      if (hit.best > bestIndirect.best) bestIndirect = hit;
    }
    if (bestIndirect.best >= 18) return bestIndirect.bestId;

    const mapped = mapGeminiClusterToKeyword(label);
    if (mapped) {
      const second = bestCategoryScore(categories, mapped, prefer, mergedExclude);
      if (second.best >= 18) return second.bestId;
    }

    const outros = categories.find(
      (c) => c && /outros|diversos/i.test(String(c.name || '')) && (!c.type || prefer.includes(c.type))
    );
    return outros?.id || null;
  } catch (e) {
    return null;
  }
}

/** Há linha de produto/estoque no documento (evita forçar suggested_category → Compras e fretes). */
function docItemsSuggestRetailStock(docData) {
  if (!docData || !Array.isArray(docData.items)) return false;
  for (const it of docData.items) {
    const blob = [it.description, it.desc, it.category, it.ncm_category_reference].filter(Boolean).join(' | ');
    if (blob && (labelLooksLikeRetailStockLine(blob) || labelLooksLikeEmbutidos(blob))) return true;
  }
  return false;
}

module.exports = {
  matchCompanyCategoryId,
  normalizeLabel,
  scoreLabels,
  isTaxExpenseCategoryName,
  labelSuggestsTaxOrPayrollLine,
  labelLooksLikeRetailStockLine,
  labelLooksLikeEmbutidos,
  isComprasOuFreteGenerico,
  categoryIdIsComprasOuFreteGenerico,
  docItemsSuggestRetailStock,
};
