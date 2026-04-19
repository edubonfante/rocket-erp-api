const supabase = require('../db');
const logger = require('../utils/logger');

/** NCM: só dígitos, até 8 posições. */
function normalizeNcmDigits(ncm) {
  return String(ncm ?? '')
    .replace(/\D/g, '')
    .slice(0, 8);
}

function normalizeLoose(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Charcutaria / embutidos: priorizar "Frios e Embutidos" do plano varejo (evita cair em Secos / alimentos secos genérico).
 */
function inferRetailNcmHighlight(item) {
  const blob = normalizeLoose([item.description, item.category, item.ncm].filter(Boolean).join(' '));
  const digits = normalizeNcmDigits(item.ncm);
  const lex =
    /\b(salsicha|mortadela|presunto|salame|linguica|linguia|peito de peru|fiambre|apresuntado|embutid|defumad|bacon|nugget|blanquet|calabresa|rocambole|paio|mortadel|salamin|charque|copalombo|copa lombo|pernil|toucinho|panceta|lombo canadense)\b/.test(
      blob,
    );
  /* 0210 = carnes salgadas/defumadas; 1601/1602 = preparações e embutidos; 1604 = preparações de carne/peixe. */
  const ncmEmb = /^(0210|1601|1602|1604)/.test(digits);
  if (lex || ncmEmb) return 'Frios e Embutidos';
  return null;
}

function mergeNcmReferenceWithHeuristics(item, refFromDb) {
  const hi = inferRetailNcmHighlight(item);
  if (hi) return hi;
  return refFromDb || null;
}

async function lookupNcmCategoryNameByPrefix4(prefix4) {
  const p = normalizeNcmDigits(prefix4).slice(0, 4);
  if (p.length < 4) return null;
  const { data, error } = await supabase
    .from('ncm_categories')
    .select('category_name')
    .like('ncm_code', `${p}%`)
    .limit(1);
  if (error) {
    logger.warn('ncm_categories lookup:', error.message);
    return null;
  }
  return data?.[0]?.category_name || null;
}

async function lookupNcmCategoryNamesForPrefixes(prefixSet) {
  const p4list = [...prefixSet].filter((x) => x && String(x).length === 4);
  const entries = await Promise.all(
    p4list.map(async (p4) => {
      const name = await lookupNcmCategoryNameByPrefix4(p4);
      return [p4, name];
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * Anexa `ncm_category_reference` (rótulo da tabela `ncm_categories`) em cada item que tiver NCM.
 * Usado após o Gemini e antes do casamento com o plano de contas da empresa.
 * @param {object|null} docData - objeto com `items[]` (description, ncm, category, …)
 */
async function enrichGeminiDocItemsWithNcmReference(docData) {
  if (!docData || typeof docData !== 'object') return docData;
  const items = Array.isArray(docData.items) ? docData.items : [];
  if (!items.length) return docData;

  const prefixes = new Set();
  for (const it of items) {
    const p4 = normalizeNcmDigits(it.ncm).slice(0, 4);
    if (p4.length === 4) prefixes.add(p4);
  }
  /* Mesmo sem NCM no cupom, descrição (salsicha, presunto…) deve gerar ncm_category_reference via heurística. */
  const map = prefixes.size ? await lookupNcmCategoryNamesForPrefixes(prefixes) : {};
  const nextItems = items.map((it) => {
    const p4 = normalizeNcmDigits(it.ncm).slice(0, 4);
    const refDb = p4.length === 4 ? map[p4] : null;
    const ref = mergeNcmReferenceWithHeuristics(it, refDb);
    if (!ref) return it;
    return { ...it, ncm_category_reference: ref };
  });
  return { ...docData, items: nextItems };
}

/**
 * Cupom de uma linha: Gemini às vezes deixa suggested_category genérico; se os itens já têm
 * `ncm_category_reference` (heurística ou tabela), alinha o documento ao que predomina.
 */
function applyDominantCategoryFromItems(docData) {
  if (!docData || typeof docData !== 'object' || !Array.isArray(docData.items) || !docData.items.length) {
    return docData;
  }
  const refs = [];
  for (const it of docData.items) {
    const r = String(it.ncm_category_reference || '').trim();
    if (r) refs.push(r);
  }
  if (!refs.length) return docData;
  const counts = {};
  for (const r of refs) counts[r] = (counts[r] || 0) + 1;
  let top = '';
  let topN = 0;
  for (const [k, v] of Object.entries(counts)) {
    if (v > topN) {
      topN = v;
      top = k;
    }
  }
  if (!top || topN < Math.ceil(refs.length * 0.51)) return docData;
  const sug = docData.suggested_category != null ? String(docData.suggested_category).trim() : '';
  const weak =
    !sug
    || /^outros$/i.test(sug)
    || /outros\s+custos\s+vari/i.test(sug)
    || /compras\s+e\s+fretes/i.test(sug)
    || /^compras$/i.test(sug)
    || /^secos$/i.test(sug)
    || /^mercearia$/i.test(sug);
  if (weak) return { ...docData, suggested_category: top };
  return docData;
}

/** Uso pontual (ex.: import XML NF-e). */
async function lookupNcmCategoryName(ncmCode) {
  const p4 = normalizeNcmDigits(ncmCode).slice(0, 4);
  if (p4.length < 4) return null;
  return lookupNcmCategoryNameByPrefix4(p4);
}

module.exports = {
  normalizeNcmDigits,
  lookupNcmCategoryName,
  enrichGeminiDocItemsWithNcmReference,
  applyDominantCategoryFromItems,
  mergeNcmReferenceWithHeuristics,
  inferRetailNcmHighlight,
};
