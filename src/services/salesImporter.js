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
      const result = await gemini.readDocument(buffer, mimetype || 'image/jpeg');
      if (!result.success) throw new Error(`Erro ao analisar a imagem: ${result.error}`);
      rows = [this.fromGeminiDoc(result.data)];
    } else throw new Error(`Formato não suportado: ${ext}`);

    const normalized = this.normalize(rows);
    const isExcelOrCsv = ['csv', 'txt', 'xlsx', 'xls'].includes(ext);
    if (normalized.length === 0 && isExcelOrCsv && process.env.GEMINI_API_KEY) {
      try {
        const gRows = await this.parseWithGemini(buffer, filename);
        const gNorm = this.normalize(gRows);
        if (gNorm.length) return gNorm;
      } catch (e) {
        logger.warn('Gemini vendas (fallback):', e.message);
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
   * Quando CSV/Excel não casa com colunas heurísticas, envia um trecho ao Gemini.
   */
  async parseWithGemini(buffer, filename) {
    const ext = filename.split('.').pop().toLowerCase();
    if (['csv', 'txt'].includes(ext)) {
      const text = buffer.toString('utf-8');
      const head = text.slice(0, 14000);
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
      for (const sheetName of names.slice(0, 12)) {
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) continue;
        const tsv = xlsx.utils.sheet_to_csv(sheet, { FS: '\t' });
        const lines = tsv.split('\n').filter((l) => l.replace(/[\s\t,;]/g, '').length > 0);
        const snip = lines.slice(0, 55).join('\n');
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
    const content = buffer.toString('utf-8');
    // Tenta detectar separador (vírgula ou ponto-e-vírgula)
    const separator = content.split(';').length > content.split(',').length ? ';' : ',';
    return csvParse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      delimiter: separator,
    });
  }

  /** @returns {{ rows: object[], sheetNames: string[] }} */
  parseExcel(buffer) {
    const workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true });
    const sheetNames = workbook.SheetNames || [];
    const rows = [];
    for (const sheetName of sheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;
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
      transactions.push({
        sale_date:      dateFormatted,
        gross_value:    Math.abs(amount),
        discount:       0,
        net_value:      Math.abs(amount),
        payment_method: amount > 0 ? 'credito' : 'debito',
        quantity:       1,
        cancelled:      false,
        memo:           get('MEMO'),
        raw_data:       { amount, date: dateRaw, memo: get('MEMO') }
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

    const fieldMapForRow = (row) => {
      const keys = Object.keys(row).filter((k) => !String(k).startsWith('__'));
      const find = (...candidates) =>
        keys.find((k) => candidates.some((c) => k.toLowerCase().replace(/[^a-z0-9]/g, '').includes(c)));
      return {
        date: find('data', 'date', 'dt', 'dia', 'fecha'),
        gross: find('bruto', 'gross', 'valor', 'total', 'venda', 'receita', 'amount'),
        discount: find('desconto', 'discount', 'abatimento'),
        net: find('liquido', 'liquid', 'net', 'final', 'recebido'),
        payment: find('forma', 'pagamento', 'payment', 'tipo', 'modalidade', 'meio', 'bandeira'),
        quantity: find('qtd', 'quantidade', 'qty', 'quantity', 'itens'),
        cancelled: find('cancelado', 'cancel', 'devolvido', 'estorno', 'status'),
      };
    };

    const today = new Date().toISOString().split('T')[0];
    return rows.map((row) => {
      const fieldMap = fieldMapForRow(row);
      const gross = parseNum(fieldMap.gross ? row[fieldMap.gross] : 0);
      const discount = parseNum(fieldMap.discount ? row[fieldMap.discount] : 0);
      const net = fieldMap.net
        ? parseNum(row[fieldMap.net])
        : gross - discount;
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
    }).filter((r) => r.gross_value > 0 || r.net_value > 0);
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
