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

/** Mapeamento do prompt Gemini de documentos → categorias típicas do seed Rocket. */
const GEMINI_HINT_TO_KEYWORD = [
  ['bovinos', 'mercadoria'],
  ['aves', 'mercadoria'],
  ['suinos', 'mercadoria'],
  ['peixes', 'mercadoria'],
  ['embutidos', 'mercadoria'],
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

/**
 * @param {Array<{id:string,name:string,type?:string,company_id?:string|null}>} categories
 * @param {string} label
 * @param {{ preferTypes?: string[] }} [opts]
 * @returns {string|null} id da categoria
 */
function bestCategoryScore(categories, label, prefer) {
  let bestId = null;
  let best = 0;
  const lab = String(label || '');
  for (const c of categories) {
    if (c.type && prefer.length && !prefer.includes(c.type)) continue;
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
  for (const [needle, key] of GEMINI_HINT_TO_KEYWORD) {
    const words = normalizeLabel(needle).split(/\s+/).filter(Boolean);
    if (words.length && words.every((w) => hint.includes(w))) return key;
  }
  return null;
}

function matchCompanyCategoryId(categories, label, opts = {}) {
  const prefer = opts.preferTypes || ['despesa', 'ambos'];
  if (!label || !categories?.length) return null;

  const first = bestCategoryScore(categories, label, prefer);
  if (first.best >= 28) return first.bestId;

  const mapped = mapGeminiClusterToKeyword(label);
  if (mapped) {
    const second = bestCategoryScore(categories, mapped, prefer);
    if (second.best >= 22) return second.bestId;
  }

  const outros = categories.find((c) => /outros/i.test(String(c.name || '')) && (!c.type || prefer.includes(c.type)));
  return outros?.id || null;
}

module.exports = { matchCompanyCategoryId, normalizeLabel, scoreLabels };
