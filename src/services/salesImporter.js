const { parse: csvParse } = require('csv-parse/sync');
const xlsx   = require('xlsx');
const xml2js = require('xml2js');
const gemini = require('./geminiReader');
const logger = require('../utils/logger');

/**
 * Detecta e parseia qualquer arquivo de vendas.
 * Retorna array de objetos normalizados com os campos:
 * { sale_date, gross_value, discount, net_value, payment_method, quantity, cancelled, raw_data }
 */

class SalesImporter {

  /** Aceita número JSON, "123.45", "1.234,56", "R$ 10,50" */
  parseMoneyBr(val) {
    if (val == null || val === '') return 0;
    if (typeof val === 'number' && !Number.isNaN(val)) return val;
    const s = String(val).trim().replace(/[R$\s]/gi, '');
    if (!s) return 0;
    const hasComma = s.includes(',');
    const hasDot = s.includes('.');
    let norm = s;
    if (hasComma && hasDot) {
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) norm = s.replace(/\./g, '').replace(',', '.');
      else norm = s.replace(/,/g, '');
    } else if (hasComma) norm = s.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(norm);
    return Number.isFinite(n) ? n : 0;
  }

  async parse(buffer, filename, mimetype) {
    const ext = filename.split('.').pop().toLowerCase();

    let rows = [];
    const isImageSale = ['jpg','jpeg','png','webp','pdf'].includes(ext);
    if (['csv', 'txt'].includes(ext))          rows = this.parseCSV(buffer);
    else if (['xlsx', 'xls'].includes(ext))    rows = this.parseExcel(buffer).rows;
    else if (ext === 'json')                   rows = this.parseJSON(buffer);
    else if (ext === 'xml')                    rows = await this.parseXML(buffer);
    else if (ext === 'ofx')                    rows = this.parseOFX(buffer.toString());
    else if (isImageSale) {
      const result = await gemini.readDocument(buffer, mimetype || 'image/jpeg', filename);
      if (!result.success) throw new Error(`Erro ao analisar a imagem: ${result.error}`);
      rows = [this.fromGeminiDoc(result.data)];
    } else throw new Error(`Formato não suportado: ${ext}`);

    let normalized = this.normalize(rows);
    const isExcelOrCsv = ['csv', 'txt', 'xlsx', 'xls'].includes(ext);
    const geminiMode = String(process.env.SALES_IMPORT_GEMINI || 'auto').toLowerCase();
    if (isExcelOrCsv && process.env.GEMINI_API_KEY && geminiMode !== 'never') {
      try {
        const geminiNorm = await this.tryGeminiSalesAssist(buffer, filename, ext, rows, normalized, geminiMode);
        if (geminiNorm?.length) normalized = geminiNorm;
      } catch (e) {
        logger.warn('Gemini vendas:', e.message);
      }
      /* Heurística zerou tudo mas o arquivo tem corpo — segunda passagem direta no Gemini (ex.: colunas fora do padrão). */
      if (!normalized.length) {
        try {
          const gRows = await this.parseWithGemini(buffer, filename);
          const again = this.normalize(gRows);
          if (again.length) normalized = again;
        } catch (e) {
          logger.warn('Gemini vendas (fallback 0 linhas):', e.message);
        }
      }
    }
    if (isImageSale && normalized.length === 0) {
      throw new Error(
        'Nenhuma venda detectada no documento (valor total zerado ou em formato não reconhecido). Confira se a foto está legível.'
      );
    }
    return normalized;
  }

  /**
   * Decide quando vale chamar o Gemini além do parser heurístico.
   * SALES_IMPORT_GEMINI: auto (padrão) | always | never
   */
  async tryGeminiSalesAssist(buffer, filename, ext, rawRows, heuristicNorm, mode) {
    const sourceCount = Array.isArray(rawRows) ? rawRows.length : 0;
    const h = heuristicNorm || [];

    const outrosRatio =
      h.length > 0 ? h.filter((r) => r.payment_method === 'outros').length / h.length : 0;

    const likelyMissedRows =
      sourceCount >= 5
      && h.length > 0
      && (h.length + 1 < sourceCount || h.length < Math.max(5, Math.floor(sourceCount * 0.55)));

    /* Muitas linhas brutas mas quase nada virou venda — colunas de valor/data provavelmente erradas. */
    const heuristicSuspicious =
      sourceCount >= 8 && h.length > 0 && h.length <= Math.max(2, Math.floor(sourceCount * 0.12));

    const mostlyMissed =
      sourceCount >= 6 && h.length > 0 && h.length < Math.max(3, Math.floor(sourceCount * 0.22));

    const useGemini =
      mode === 'always' ||
      h.length === 0 ||
      likelyMissedRows ||
      heuristicSuspicious ||
      mostlyMissed ||
      (h.length >= 3 && outrosRatio >= 0.68);

    if (!useGemini) return null;

    const gRows = await this.parseWithGemini(buffer, filename);
    const gNorm = this.normalize(gRows);

    if (mode === 'always') {
      if (gNorm.length) return gNorm;
      return h.length ? h : null;
    }
    if (!gNorm.length) return null;
    if (h.length === 0) return gNorm;
    if (gNorm.length >= h.length) return gNorm;
    if (likelyMissedRows && gNorm.length > h.length) return gNorm;
    /* Não substituir heurística boa por Gemini com MENOS linhas (evita “só incompleto”). */
    if (heuristicSuspicious && gNorm.length > h.length) return gNorm;
    if (mostlyMissed && gNorm.length > h.length) return gNorm;
    if (outrosRatio >= 0.68 && gNorm.length >= Math.ceil(h.length * 0.85)) return gNorm;
    return null;
  }

  /**
   * Quando CSV/Excel não casa com colunas heurísticas, envia um trecho ao Gemini.
   */
  async parseWithGemini(buffer, filename) {
    const ext = filename.split('.').pop().toLowerCase();
    if (['csv', 'txt'].includes(ext)) {
      const text = buffer.toString('utf-8');
      const head = text.slice(0, 70000);
      if (!head.trim()) return [];
      const result = await gemini.readSalesSnippet(filename, 'CSV', head);
      if (!result.success) throw new Error(result.error || 'Gemini não interpretou o arquivo');
      const arr = Array.isArray(result.data?.sales) ? result.data.sales : [];
      return arr.map((r) => ({ ...r, __gemini: true, __sheet: 'CSV' }));
    }
    if (['xlsx', 'xls'].includes(ext)) {
      const workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true });
      const names = workbook.SheetNames || [];
      const parts = [];
      const maxSheets = Math.min(120, names.length);
      for (const sheetName of names.slice(0, maxSheets)) {
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) continue;
        this.expandWorksheetRange(sheet);
        const tsv = xlsx.utils.sheet_to_csv(sheet, { FS: '\t' });
        const lines = tsv.split('\n').filter((l) => l.replace(/[\s\t,;]/g, '').length > 0);
        const snip = lines.slice(0, 500).join('\n');
        if (snip.replace(/[\d./\-:\s]/g, '').trim().length < 6) continue;
        parts.push({ sheetName, snippet: snip });
      }
      if (!parts.length) return [];
      const result = await gemini.readSalesWorkbook(filename, parts);
      if (!result.success) throw new Error(result.error || 'Gemini não interpretou a planilha');
      const arr = Array.isArray(result.data?.sales) ? result.data.sales : [];
      return arr.map((r) => ({
        ...r,
        __gemini: true,
        __sheet: r.__sheet || r.sheet || parts[0]?.sheetName,
      }));
    }
    return [];
  }

  fromGeminiDoc(doc) {
    const num = (v) => this.parseMoneyBr(v);
    const today = new Date().toISOString().split('T')[0];
    const issue = doc.issue_date || doc.due_date || today;
    const total = num(doc.total_value);
    const discount = num(doc.discount);
    const gross = doc.subtotal != null ? num(doc.subtotal) : (discount ? total + discount : total);
    const net = total || Math.max(gross - discount, 0);
    const qty = Array.isArray(doc.items) && doc.items.length
      ? doc.items.reduce((s, it) => s + (parseFloat(it.quantity) || 1), 0)
      : 1;
    return {
      sale_date: issue,
      gross_value: gross,
      discount: discount,
      net_value: net,
      payment_method: doc.payment_method || null,
      quantity: qty,
      cancelled: false,
      raw_data: doc,
    };
  }

  parseCSV(buffer) {
    const content = buffer.toString('utf-8').replace(/^\uFEFF/, '');
    const first = content.split(/\r?\n/).find((l) => String(l).replace(/\s/g, '').length > 0) || '';
    const tabs = (first.match(/\t/g) || []).length;
    const semi = (first.match(/;/g) || []).length;
    const commas = (first.match(/,/g) || []).length;
    let delimiter = ',';
    if (tabs >= 1 && tabs >= semi && tabs >= commas) delimiter = '\t';
    else if (semi > commas) delimiter = ';';
    return csvParse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      delimiter,
      relax_column_count: true,
    });
  }

  /**
   * Alguns arquivos vêm com `!ref` truncado; `sheet_to_json` respeita só esse range e perde linhas/colunas.
   * Recalcula o retângulo a partir de todas as células presentes na aba.
   */
  expandWorksheetRange(sheet) {
    if (!sheet || typeof sheet !== 'object') return;
    let maxR = -1;
    let maxC = -1;
    for (const k of Object.keys(sheet)) {
      if (k[0] === '!') continue;
      if (!/^[A-Za-z]{1,4}\d+$/.test(k)) continue;
      try {
        const addr = xlsx.utils.decode_cell(k);
        if (addr.r > maxR) maxR = addr.r;
        if (addr.c > maxC) maxC = addr.c;
      } catch (_) { /* ignore bad keys */ }
    }
    if (maxR < 0 || maxC < 0) return;
    let s0 = { r: 0, c: 0 };
    let ePrev = { r: maxR, c: maxC };
    if (sheet['!ref']) {
      try {
        const prev = xlsx.utils.decode_range(sheet['!ref']);
        s0 = prev.s || s0;
        ePrev = prev.e;
      } catch (_) { /* keep defaults */ }
    }
    const e = { r: Math.max(ePrev.r, maxR), c: Math.max(ePrev.c, maxC) };
    sheet['!ref'] = xlsx.utils.encode_range({ s: s0, e });
  }

  /** @returns {{ rows: object[], sheetNames: string[] }} */
  parseExcel(buffer) {
    const workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true });
    const sheetNames = workbook.SheetNames || [];
    const rows = [];
    for (const sheetName of sheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;
      this.expandWorksheetRange(sheet);
      const json = xlsx.utils.sheet_to_json(sheet, { defval: null });
      for (const r of json) {
        if (r == null || typeof r !== 'object') continue;
        const empty = Object.keys(r).every(k => r[k] == null || String(r[k]).trim() === '');
        if (empty) continue;
        rows.push({ ...r, __sheet: sheetName });
      }
    }
    return { rows, sheetNames };
  }

  /** Lista nomes das abas (útil na prévia sem re-parse completo). */
  listExcelSheetNames(buffer) {
    try {
      const workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true });
      return workbook.SheetNames || [];
    } catch {
      return [];
    }
  }

  parseJSON(buffer) {
    const data = JSON.parse(buffer.toString());
    return Array.isArray(data) ? data : data.data || data.vendas || data.sales || [];
  }

  async parseXML(buffer) {
    const parsed = await xml2js.parseStringPromise(buffer.toString(), { explicitArray: false });
    // Detecta estrutura: tenta encontrar array de itens
    const root = Object.values(parsed)[0];
    const candidates = ['venda', 'sale', 'item', 'registro', 'lancamento', 'cupom'];
    for (const c of candidates) {
      if (root?.[c]) return Array.isArray(root[c]) ? root[c] : [root[c]];
    }
    // Fallback: pega o primeiro array encontrado
    for (const val of Object.values(root || {})) {
      if (Array.isArray(val)) return val;
    }
    return [];
  }

  parseOFX(content) {
    // OFX é um formato semi-XML — parseia as transações
    const transactions = [];
    const stmttrns = content.match(/<STMTTRN>([\s\S]*?)<\/STMTTRN>/g) || [];
    for (const trn of stmttrns) {
      const get = (tag) => {
        const match = trn.match(new RegExp(`<${tag}>([^<]+)`));
        return match ? match[1].trim() : null;
      };
      const amount = parseFloat(get('TRNAMT') || '0');
      const dateRaw = get('DTPOSTED') || '';
      const dateFormatted = dateRaw.length >= 8
        ? `${dateRaw.slice(0,4)}-${dateRaw.slice(4,6)}-${dateRaw.slice(6,8)}`
        : null;
      const memo = get('MEMO');
      const name = get('NAME');
      const payee = get('PAYEE');
      const trnType = get('TRNTYPE');
      const refNum = get('REFNUM');
      transactions.push({
        sale_date:      dateFormatted,
        gross_value:    Math.abs(amount),
        discount:       0,
        net_value:      Math.abs(amount),
        payment_method: amount > 0 ? 'credito' : 'debito',
        quantity:       1,
        cancelled:      false,
        memo,
        name,
        payee,
        raw_data:       {
          amount,
          date: dateRaw,
          memo,
          name,
          payee,
          trntype: trnType,
          refnum: refNum,
        }
      });
    }
    return transactions;
  }

  normalizePayment(val) {
    if (!val) return 'outros';
    const v = String(val).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (v.includes('pix')) return 'pix';
    if (v.includes('dinheiro') || v.includes('cash')) return 'dinheiro';
    if (v.includes('credito') || v.includes('credit')) return 'credito';
    if (v.includes('debito') || v.includes('debit')) return 'debito';
    if (v.includes('voucher') || v.includes('vale')) return 'voucher';
    if (v.includes('boleto')) return 'boleto';
    if (v.includes('transferencia') || v.includes('ted') || v.includes('doc')) return 'transferencia';
    if (v.includes('cupom') || v.includes('coupon')) return 'cupom';
    return String(val).toLowerCase().slice(0, 30);
  }

  /**
   * Normaliza qualquer array de objetos para o schema padrão de vendas.
   * Detecta campos por similaridade de nome (por linha — suporta várias abas Excel com colunas diferentes).
   */
  normalize(rows) {
    if (!rows.length) return [];

    const parseNum = (val) => this.parseMoneyBr(val);

    const parseDate = (val) => {
      if (!val) return null;
      if (val instanceof Date) return val.toISOString().split('T')[0];
      const s = String(val).trim();
      if (/^\d{2}\/\d{2}\/\d{4}/.test(s))
        return `${s.slice(6, 10)}-${s.slice(3, 5)}-${s.slice(0, 2)}`;
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
      if (/^\d{8}$/.test(s))
        return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
      return s;
    };

    const isCancelled = (val) => {
      if (!val) return false;
      const v = String(val).toLowerCase();
      return v === '1' || v === 'true' || v === 's' || v === 'sim' || v.includes('cancel') || v.includes('estorn');
    };

    const taxishKey = (k) => {
      const lk = String(k || '').toLowerCase();
      return /icms|ipi|pis|cofins|iss\b|imposto|substitu|retido|incluso|base\s*calc|diferencial|taxa\b|tarifa\b|juros|multa|desconto\s*fin/i.test(lk);
    };

    /** Escolhe a coluna de valor da venda (evita “Valor ICMS”, “Base …” como valor principal). */
    const pickGrossColumnKey = (keys) => {
      let bestK = null;
      let bestS = -1e9;
      for (const k of keys) {
        if (String(k).startsWith('__')) continue;
        if (taxishKey(k)) continue;
        const nk = String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
        let s = 0;
        if (nk.includes('vlrmov') || nk.includes('valormov') || nk.includes('valorlanc') || nk.includes('valoroper')) s += 80;
        if (/valor.*(liqu|liq)/.test(nk) || nk.includes('valliq') || nk.includes('valorliq')) s += 70;
        if (/valor.*(total|venda|receita)/.test(nk)) s += 55;
        if (nk === 'valor' || /^valor$/i.test(String(k).trim())) s += 45;
        if (nk.includes('valor')) s += 28;
        if (nk.includes('venda') || nk.includes('receita') || nk.includes('totalvenda') || nk.includes('totvenda')) s += 40;
        if (nk.includes('bruto') || nk.includes('gross') || nk.includes('amount') || nk.includes('vlvenda')) s += 38;
        if (nk.includes('credit') || nk.includes('credito') || nk.includes('debit') || nk.includes('debito')) s += 12;
        if (s > bestS) {
          bestS = s;
          bestK = k;
        }
      }
      return bestS >= 12 ? bestK : null;
    };

    const fieldMapForRow = (row) => {
      const keys = Object.keys(row).filter((k) => !String(k).startsWith('__'));
      const find = (...candidates) =>
        keys.find((k) => {
          if (taxishKey(k)) return false;
          const nk = k.toLowerCase().replace(/[^a-z0-9]/g, '');
          return candidates.some((c) => nk.includes(c));
        });
      const grossKey = pickGrossColumnKey(keys)
        || find(
          'bruto', 'gross', 'total', 'venda', 'receita', 'amount',
          'vlrmov', 'vlmov', 'valorlan', 'vallan', 'vloper', 'vltrans',
        )
        || find('valor');
      return {
        date: find('data', 'date', 'dt', 'dia', 'fecha', 'dtmov', 'dtmovimento', 'datalanc', 'dtlanc', 'datatrans', 'datahora'),
        gross: grossKey,
        discount: find('desconto', 'discount', 'abatimento'),
        net: find('liquido', 'liquid', 'net', 'final', 'recebido', 'valorliqu', 'valliq'),
        payment: find('forma', 'pagamento', 'payment', 'tipo', 'modalidade', 'meio', 'bandeira'),
        quantity: find('qtd', 'quantidade', 'qty', 'quantity', 'itens'),
        cancelled: find('cancelado', 'cancel', 'devolvido', 'estorno', 'status'),
      };
    };

    const inferMoneyFromRow = (row, fieldMap) => {
      let best = 0;
      const skip = new Set();
      for (const fk of ['date', 'gross', 'discount', 'net', 'payment', 'quantity', 'cancelled']) {
        const k = fieldMap[fk];
        if (k) skip.add(k);
      }
      for (const [k, v] of Object.entries(row)) {
        if (String(k).startsWith('__') || skip.has(k)) continue;
        const lk = String(k).toLowerCase();
        if (taxishKey(k) || /saldo|balance|percent|taxa|tarifa|hora\b|agencia|agência|conta|banco|linha|sheet|row|idx|fone|cep|^cod|^id$/i.test(lk)) {
          continue;
        }
        const n = parseNum(v);
        if (!Number.isFinite(n) || Math.abs(n) < 1e-9 || Math.abs(n) > 1e13) continue;
        if (typeof v === 'number' && Number.isInteger(v) && Math.abs(n) < 400
          && !/valor|vlr|vl|cred|deb|total|preco|preço|oper|mov|lan/i.test(lk)) continue;
        if (Math.abs(n) > Math.abs(best)) best = n;
      }
      return best;
    };

    const today = new Date().toISOString().split('T')[0];
    return rows.map((row) => {
      const fieldMap = fieldMapForRow(row);
      let gross = parseNum(fieldMap.gross ? row[fieldMap.gross] : 0);
      const discount = parseNum(fieldMap.discount ? row[fieldMap.discount] : 0);
      let net = fieldMap.net
        ? parseNum(row[fieldMap.net])
        : gross - discount;
      if (Math.abs(gross) < 1e-9 && Math.abs(net) < 1e-9) {
        const inferred = inferMoneyFromRow(row, fieldMap);
        if (Math.abs(inferred) > 1e-9) {
          gross = inferred;
          net = inferred;
        }
      }
      const saleDate = parseDate(fieldMap.date ? row[fieldMap.date] : null) || today;

      return {
        sale_date: saleDate,
        gross_value: gross,
        discount,
        net_value: net || gross,
        payment_method: this.normalizePayment(fieldMap.payment ? row[fieldMap.payment] : null),
        quantity: parseInt(fieldMap.quantity ? row[fieldMap.quantity] : 1, 10) || 1,
        cancelled: isCancelled(fieldMap.cancelled ? row[fieldMap.cancelled] : false),
        raw_data: row,
      };
    }).filter((r) => {
      const g = parseFloat(r.gross_value) || 0;
      const n = parseFloat(r.net_value) || 0;
      return Math.abs(g) > 1e-9 || Math.abs(n) > 1e-9;
    });
  }

  summary(rows) {
    const valid  = rows.filter(r => !r.cancelled);
    return {
      total:          rows.length,
      valid:          valid.length,
      cancelled:      rows.filter(r => r.cancelled).length,
      total_gross:    valid.reduce((s, r) => s + r.gross_value, 0),
      total_discount: valid.reduce((s, r) => s + r.discount, 0),
      total_net:      valid.reduce((s, r) => s + r.net_value, 0),
      period_start:   rows.map(r => r.sale_date).filter(Boolean).sort()[0],
      period_end:     rows.map(r => r.sale_date).filter(Boolean).sort().at(-1),
      by_payment:     valid.reduce((acc, r) => {
        acc[r.payment_method] = (acc[r.payment_method] || 0) + r.net_value;
        return acc;
      }, {}),
    };
  }
}

module.exports = new SalesImporter();
