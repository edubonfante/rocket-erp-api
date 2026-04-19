const xlsx = require('xlsx');
const importer = require('../services/salesImporter');

function coerceBankDate(val) {
  const s = val != null ? String(val).trim() : '';
  if (!s) return new Date().toISOString().split('T')[0];
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{2}\/\d{2}\/\d{4}/.test(s)) return `${s.slice(6, 10)}-${s.slice(3, 5)}-${s.slice(0, 2)}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return new Date().toISOString().split('T')[0];
}

/** Gemini às vezes devolve rótulos em PT/EN alternativos; normaliza para uma descrição útil. */
function pickGeminiBankDescription(t) {
  const parts = [
    t.description,
    t.descricao,
    t.detalhe,
    t.detalhes,
    t.historico,
    t.histórico,
    t.memo,
    t.texto,
    t.merchant,
    t.establishment,
    t.estabelecimento,
    t.payee,
    t.name,
    t.concept,
    t.motivo,
    t.lancamento,
    t.identificacao,
    t.favorecido,
    t.razao_social,
    t['razão social'],
  ];
  for (const p of parts) {
    const s = p != null ? String(p).trim() : '';
    if (s.length >= 2 && s !== '—' && s !== '-') return s.slice(0, 300);
  }
  const doc = t.doc_number != null ? String(t.doc_number).trim() : '';
  if (doc.length >= 2) return `Doc. ${doc}`.slice(0, 300);
  return '';
}

function normalizeHeaderKey(k) {
  return String(k || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

/** Extrai descrição rica do extrato (colunas Lançamento, Nome, Histórico etc., com chaves normalizadas). */
function pickBankDescriptionFromRow(r) {
  const raw = r.raw_data && typeof r.raw_data === 'object' ? r.raw_data : r;
  const byNorm = {};
  for (const [k, v] of Object.entries(raw)) {
    if (String(k).startsWith('__')) continue;
    byNorm[normalizeHeaderKey(k)] = { orig: k, val: v };
  }

  const cell = (...hints) => {
    for (const h of hints) {
      const nh = normalizeHeaderKey(h).replace(/\s/g, '');
      for (const [kn, { val }] of Object.entries(byNorm)) {
        const kk = kn.replace(/\s/g, '');
        if (kk === nh || kk.includes(nh) || nh.includes(kk)) {
          if (val == null) continue;
          const s = String(val).trim();
          if (s.length >= 2 && !/^\d+([.,]\d+)?$/.test(s)) return s;
        }
      }
    }
    return '';
  };

  const lanc = cell('lancamento', 'lançamento', 'movimento', 'movimentacao', 'tipo lancamento', 'tipo de lancamento', 'operacao', 'operação', 'trntype');
  const nome = cell(
    'nome', 'name', 'payee', 'payeename', 'favorecido', 'beneficiario', 'beneficiário',
    'credenciado', 'estabelecimento', 'merchant', 'titular', 'razao social', 'razão social',
  );
  const hist = cell(
    'historico', 'histórico', 'descricao', 'descrição', 'detalhe', 'detalhes', 'identificacao', 'identificação',
    'complemento', 'texto', 'observacao', 'observação', 'titulo', 'título', 'origem', 'destino', 'particular',
    'informacoes', 'informações', 'lancamento', 'lançamento',
  );
  const memo = cell('memo', 'informacao', 'informação', 'portador', 'doc', 'documento');

  const merged = [lanc, nome].filter(Boolean);
  if (hist && merged.length) {
    const hlow = hist.toLowerCase();
    const redundant = merged.some((m) => m.toLowerCase().includes(hlow) || hlow.includes(m.toLowerCase()));
    if (!redundant) merged.push(hist);
  } else if (hist) merged.push(hist);
  if (!merged.length && memo) merged.push(memo);
  if (merged.length) return merged.join(' — ').slice(0, 300);

  const scored = [];
  for (const [k, v] of Object.entries(raw)) {
    if (String(k).startsWith('__')) continue;
    if (v == null) continue;
    const s = String(v).trim();
    if (s.length < 4) continue;
    if (/^\d+([.,]\d+)?$/.test(s)) continue;
    const lk = String(k).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (/data|valor|saldo|date|amount|venc|qtd|codigo|cod\b|id\b|sheet|agencia|conta|banco/i.test(lk)) continue;
    let score = 5;
    if (/lanc|nome|hist|descr|detalhe|favorec|benef|texto|memo/i.test(lk)) score += 40;
    scored.push({ score, s: s.slice(0, 300) });
  }
  scored.sort((a, b) => b.score - a.score);
  if (scored.length) return scored[0].s;

  const textCells = [];
  for (const [k, v] of Object.entries(raw)) {
    if (String(k).startsWith('__')) continue;
    const lk = String(k).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (/data|valor|saldo|date|amount|balance|sheet|row|idx|indice|agencia|agência|conta|banco|codigo|cod\b|id\b|tipo\s*de\s*valor/i.test(lk)) continue;
    if (v == null) continue;
    const s = String(v).trim();
    if (s.length < 2) continue;
    if (/^\d+([.,]\d+)?$/.test(s)) continue;
    textCells.push(s);
  }
  if (textCells.length) {
    const joined = [...new Set(textCells)].join(' — ').slice(0, 300);
    if (joined.replace(/\s/g, '').length >= 2) return joined;
  }

  const m = r.memo || raw.memo || raw.MEMO || raw.name || raw.NAME || raw.payee || '';
  return String(m || 'Movimentação').slice(0, 300);
}

/** Texto rico para o Gemini (descrição + colunas úteis do extrato). */
function buildBankAiText(t) {
  const base = String(t.description || '').trim();
  const raw = t.raw_data && typeof t.raw_data === 'object' ? t.raw_data : null;
  if (!raw) return base;
  const bits = [];
  if (base) bits.push(base);
  for (const [k, v] of Object.entries(raw)) {
    if (String(k).startsWith('__')) continue;
    const s = v != null ? String(v).trim() : '';
    if (s.length < 2 || /^[\d.,]+$/.test(s)) continue;
    const nk = normalizeHeaderKey(k).replace(/\s/g, '');
    if (/data|valor|saldo|date|amount|balance|sheet|row|idx|banco|agencia|conta|codigo/.test(nk)) continue;
    bits.push(`${k}: ${s}`.slice(0, 700));
  }
  return [...new Set(bits)].join(' | ').slice(0, 2500);
}

function formatCategoryLabelsForAi(catList) {
  return (catList || []).map((c) => {
    const code = String(c.account_code || '').trim();
    const name = String(c.name || '').trim();
    if (code && name) return `${code} — ${name}`;
    return name || code;
  }).filter(Boolean);
}

/**
 * Extratos em CSV costumam ter valor sempre positivo + coluna D/C ou tipo débito/crédito.
 * Sem isso, tudo vira receita quando `payment_method` não é `debito`.
 */
function inferSignedAmountFromBankRow(r) {
  const raw = r.raw_data && typeof r.raw_data === 'object' ? r.raw_data : null;
  if (!raw) return null;
  let explicitNum = null;
  let parsedFromCell = null;
  let stringLooksNegative = false;
  let dc = null;
  for (const [k, v] of Object.entries(raw)) {
    if (String(k).startsWith('__')) continue;
    const nk = normalizeHeaderKey(k).replace(/\s/g, '');
    if (/saldo|balance/.test(nk)) continue;
    if (nk === 'amount' || /valor/.test(nk)) {
      if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) > 1e-9) explicitNum = v;
      const vs = v != null ? String(v).trim() : '';
      if (/^\(.+\)$/.test(vs)) stringLooksNegative = true;
      if (vs.startsWith('-')) stringLooksNegative = true;
      const n = importer.parseMoneyBr(v);
      if (Math.abs(n) > 1e-9) parsedFromCell = n;
    }
    if (/^(dc|d\/c|c\/d)$/.test(nk) || /indicador.*(cred|deb)|natureza/.test(nk)) {
      const u = String(v || '').trim().toUpperCase();
      if (/^D|DEB|SAI|SAÍ|RET|PAG/.test(u)) dc = 'D';
      if (/^C|CRED|ENT|REC|DEP/.test(u)) dc = 'C';
    }
    if (/tipo.*lanc|tipo.*mov|operacao|operacao/.test(nk)) {
      const low = String(v || '').toLowerCase();
      if (/debit|débit|sa[ií]da|pagamento/.test(low)) dc = 'D';
      if (/credit|créd|entrada|dep[oó]s|receb/.test(low)) dc = 'C';
    }
  }
  if (explicitNum != null) return explicitNum;
  if (parsedFromCell != null) {
    if (parsedFromCell < 0) return parsedFromCell;
    if (stringLooksNegative) return -Math.abs(parsedFromCell);
    if (dc === 'D') return -Math.abs(parsedFromCell);
    if (dc === 'C') return Math.abs(parsedFromCell);
  }
  return null;
}

/** Mesmo mapeamento do extrato lido por imagem no Gemini — reutilizado para CSV/XLSX via texto. */
function mapGeminiExtratoPayloadToTransactions(data) {
  const list = Array.isArray(data?.transactions) ? data.transactions : [];
  return list.map((t) => {
    const raw = parseFloat(t.amount);
    const amount = Number.isFinite(raw) ? Math.round(raw * 100) / 100 : 0;
    const balRaw = t.balance != null ? parseFloat(t.balance) : null;
    const balance = balRaw != null && Number.isFinite(balRaw) ? Math.round(balRaw * 100) / 100 : null;
    const entryDate = coerceBankDate(t.date);
    let description = pickGeminiBankDescription(t);
    const compact = description.replace(/\s/g, '').replace(/[—\-]/g, '');
    if (compact.length < 2) {
      description = [entryDate, amount ? `${amount > 0 ? '+' : ''}${amount}` : null]
        .filter(Boolean)
        .join(' · ')
        .slice(0, 300) || 'Movimentação';
    }
    return {
      entry_date: entryDate,
      description,
      amount,
      balance,
      raw_data: {
        source: 'gemini_csv_extrato',
        lancamento: t.lancamento != null ? String(t.lancamento).slice(0, 200) : null,
        favorecido: t.favorecido != null ? String(t.favorecido).slice(0, 300) : null,
        historico: t.historico != null ? String(t.historico).slice(0, 300) : null,
        doc_number: t.doc_number != null ? String(t.doc_number).slice(0, 80) : null,
      },
    };
  }).filter((t) => t.amount !== 0 && t.entry_date);
}

function toBankTransactions(rows) {
  return (rows || []).map((r) => {
    const desc = pickBankDescriptionFromRow(r);
    let signed = null;
    if (r.raw_data && typeof r.raw_data.amount === 'number' && !Number.isNaN(r.raw_data.amount)) {
      signed = r.raw_data.amount;
    } else {
      const inferred = inferSignedAmountFromBankRow(r);
      if (inferred != null && Number.isFinite(inferred)) signed = inferred;
    }
    if (signed == null && typeof r.net_value === 'number' && r.net_value !== 0) {
      signed = r.net_value;
    }
    if (signed == null) {
      const g = Math.abs(parseFloat(r.gross_value) || 0);
      signed = r.payment_method === 'debito' ? -g : g;
    }
    const rawSnap = r.raw_data && typeof r.raw_data === 'object' ? { ...r.raw_data } : null;
    return {
      entry_date: coerceBankDate(r.sale_date || r.raw_data?.date),
      description: desc,
      amount: Math.round(signed * 100) / 100,
      balance: r.balance != null ? parseFloat(r.balance) : null,
      raw_data: rawSnap,
    };
  }).filter((t) => t.amount !== 0 && t.entry_date);
}

/** Estimativa de linhas de movimento no arquivo (para avisar extrato incompleto). */
function estimateBankFileDataRows(buffer, ext) {
  try {
    if (['csv', 'txt'].includes(ext)) {
      const lines = buffer.toString('utf-8').split(/\r?\n/).filter((l) => l.replace(/[\s\t;,]/g, '').length > 4);
      return Math.max(0, lines.length - 1);
    }
    if (['xlsx', 'xls'].includes(ext)) {
      const wb = xlsx.read(buffer, { type: 'buffer', cellDates: true });
      const n0 = (wb.SheetNames || [])[0];
      const sh = n0 ? wb.Sheets[n0] : null;
      if (!sh) return null;
      importer.expandWorksheetRange(sh);
      const rows = xlsx.utils.sheet_to_json(sh, { defval: null });
      return rows.filter(
        (r) => r && typeof r === 'object' && Object.keys(r).some((k) => r[k] != null && String(r[k]).trim() !== ''),
      ).length;
    }
    if (ext === 'ofx') {
      const m = buffer.toString('utf-8').match(/<STMTTRN>/gi);
      return m ? m.length : 0;
    }
  } catch (_) {
    return null;
  }
  return null;
}

function bankImportCompletenessWarning(estimatedRows, txCount) {
  if (estimatedRows == null || estimatedRows < 30) return null;
  if (txCount >= Math.max(estimatedRows - 3, Math.floor(estimatedRows * 0.35))) return null;
  if (estimatedRows - txCount < 12) return null;
  return (
    `O arquivo parece ter cerca de ${estimatedRows} linhas de movimento, mas só ${txCount} lançamento(s) foram importados — o extrato pode estar incompleto. `
    + 'Remova este import na lista abaixo e envie o arquivo completo (OFX/CSV) ou imagem/PDF com todas as páginas.'
  );
}

module.exports = {
  coerceBankDate,
  pickGeminiBankDescription,
  normalizeHeaderKey,
  pickBankDescriptionFromRow,
  buildBankAiText,
  formatCategoryLabelsForAi,
  inferSignedAmountFromBankRow,
  mapGeminiExtratoPayloadToTransactions,
  toBankTransactions,
  estimateBankFileDataRows,
  bankImportCompletenessWarning,
};
