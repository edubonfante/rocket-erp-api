const supabase = require('../db');

/** Extrai o caminho do objeto dentro do bucket `rocket-erp-docs` a partir da URL pública/assina do Supabase. */
function rocketErpDocsPathFromUrl(fileUrl) {
  if (!fileUrl || typeof fileUrl !== 'string') return null;
  const m = fileUrl.match(/\/rocket-erp-docs\/(.+)$/i);
  if (!m) return null;
  const raw = m[1].split('?')[0];
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * URL assinada para leitura (bucket privado). Se não for possível, devolve null.
 * @param {string} fileUrl URL já salva (geralmente pública) ou path relativo ao bucket
 * @param {number} expiresIn segundos (padrão 7 dias)
 */
async function signRocketDocUrl(fileUrl, expiresIn = 60 * 60 * 24 * 7) {
  try {
    const path = rocketErpDocsPathFromUrl(fileUrl);
    if (!path) return null;
    const { data, error } = await supabase.storage.from('rocket-erp-docs').createSignedUrl(path, expiresIn);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch (e) {
    return null;
  }
}

module.exports = { rocketErpDocsPathFromUrl, signRocketDocUrl };
