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

module.exports = { cleanCategoryId, categoryIdIfAllowed, UUID_RE };
