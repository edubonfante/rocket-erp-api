const { parse: csvParse } = require('csv-parse/sync');
const xlsx   = require('xlsx');
const xml2js = require('xml2js');

/**
 * Detecta e parseia qualquer arquivo de vendas.
 * Retorna array de objetos normalizados com os campos:
 * { sale_date, gross_value, discount, net_value, payment_method, quantity, cancelled, raw_data }
 */

class SalesImporter {

  async parse(buffer, filename, mimetype) {
    const ext = filename.split('.').pop().toLowerCase();

    let rows = [];
    if (['csv', 'txt'].includes(ext))          rows = this.parseCSV(buffer);
    else if (['xlsx', 'xls'].includes(ext))    rows = this.parseExcel(buffer);
    else if (ext === 'json')                   rows = this.parseJSON(buffer);
    else if (ext === 'xml')                    rows = await this.parseXML(buffer);
    else if (ext === 'ofx')                    rows = this.parseOFX(buffer.toString());
    else throw new Error(`Formato não suportado: ${ext}`);

    return this.normalize(rows);
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

  parseExcel(buffer) {
    const workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    return xlsx.utils.sheet_to_json(sheet, { defval: null });
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

  /**
   * Normaliza qualquer array de objetos para o schema padrão de vendas.
   * Detecta campos por similaridade de nome.
   */
  normalize(rows) {
    if (!rows.length) return [];

    const keys = Object.keys(rows[0]);
    const find = (...candidates) =>
      keys.find(k => candidates.some(c => k.toLowerCase().replace(/[^a-z]/g,'').includes(c)));

    // Mapeamento inteligente de campos
    const fieldMap = {
      date:          find('data','date','dt','dia','fecha'),
      gross:         find('bruto','gross','valor','total','venda','receita','amount'),
      discount:      find('desconto','discount','abatimento'),
      net:           find('liquido','liquid','net','final','recebido'),
      payment:       find('forma','pagamento','payment','tipo','modalidade','meio'),
      quantity:      find('qtd','quantidade','qty','quantity','itens'),
      cancelled:     find('cancelado','cancel','devolvido','estorno','status'),
    };

    const parseNum = (val) => {
      if (!val && val !== 0) return 0;
      return parseFloat(
        String(val).replace(/[R$\s]/g,'').replace('.','').replace(',','.')
      ) || 0;
    };

    const parseDate = (val) => {
      if (!val) return null;
      if (val instanceof Date) return val.toISOString().split('T')[0];
      const s = String(val).trim();
      // DD/MM/YYYY
      if (/^\d{2}\/\d{2}\/\d{4}/.test(s))
        return `${s.slice(6,10)}-${s.slice(3,5)}-${s.slice(0,2)}`;
      // YYYY-MM-DD
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
      // YYYYMMDD
      if (/^\d{8}$/.test(s))
        return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
      return s;
    };

    const normalizePayment = (val) => {
      if (!val) return 'outros';
      const v = String(val).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
      if (v.includes('pix'))                    return 'pix';
      if (v.includes('dinheiro')||v.includes('cash')) return 'dinheiro';
      if (v.includes('credito')||v.includes('credit')) return 'credito';
      if (v.includes('debito')||v.includes('debit'))   return 'debito';
      if (v.includes('voucher')||v.includes('vale'))   return 'voucher';
      if (v.includes('boleto'))                 return 'boleto';
      if (v.includes('transferencia')||v.includes('ted')||v.includes('doc')) return 'transferencia';
      return String(val).toLowerCase().slice(0,30);
    };

    const isCancelled = (val) => {
      if (!val) return false;
      const v = String(val).toLowerCase();
      return v === '1' || v === 'true' || v === 's' || v === 'sim' || v.includes('cancel') || v.includes('estorn');
    };

    return rows.map(row => {
      const gross   = parseNum(fieldMap.gross   ? row[fieldMap.gross]   : 0);
      const discount = parseNum(fieldMap.discount ? row[fieldMap.discount] : 0);
      const net     = fieldMap.net
        ? parseNum(row[fieldMap.net])
        : gross - discount;

      return {
        sale_date:      parseDate(fieldMap.date ? row[fieldMap.date] : null),
        gross_value:    gross,
        discount:       discount,
        net_value:      net || gross,
        payment_method: normalizePayment(fieldMap.payment ? row[fieldMap.payment] : null),
        quantity:       parseInt(fieldMap.quantity ? row[fieldMap.quantity] : 1) || 1,
        cancelled:      isCancelled(fieldMap.cancelled ? row[fieldMap.cancelled] : false),
        raw_data:       row,
      };
    }).filter(r => r.gross_value > 0 || r.net_value > 0);
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
