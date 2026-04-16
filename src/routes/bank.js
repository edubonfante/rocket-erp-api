const router  = require('express').Router();
const multer  = require('multer');
const supabase = require('../db');
const gemini  = require('../services/geminiReader');
const importer = require('../services/salesImporter');
const { authenticate, requireCompanyAccess, requirePermission } = require('../middlewares/auth');
const logger = require('../utils/logger');
const { matchCompanyCategoryId } = require('../utils/categoryMatch');
const { bankCategoryHint } = require('../utils/bankCategoryHints');
const { categoryIdIfAllowed } = require('../utils/categoryIdSafe');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function coerceBankDate(val) {
  const s = val != null ? String(val).trim() : '';
  if (!s) return new Date().toISOString().split('T')[0];
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{2}\/\d{2}\/\d{4}/.test(s)) return `${s.slice(6, 10)}-${s.slice(3, 5)}-${s.slice(0, 2)}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return new Date().toISOString().split('T')[0];
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

  const lanc = cell('lancamento', 'lançamento', 'movimento', 'movimentacao', 'tipo lancamento', 'tipo de lancamento', 'operacao', 'operação');
  const nome = cell('nome', 'favorecido', 'beneficiario', 'beneficiário', 'credenciado', 'estabelecimento', 'titular', 'razao social', 'razão social');
  const hist = cell('historico', 'histórico', 'descricao', 'descrição', 'detalhe', 'identificacao', 'identificação', 'complemento', 'texto', 'observacao', 'observação');
  const memo = cell('memo', 'informacao', 'informação');

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

  const m = r.memo || raw.memo || raw.MEMO || '';
  return String(m || 'Movimentação').slice(0, 300);
}

function toBankTransactions(rows) {
  return (rows || []).map((r) => {
    const desc = pickBankDescriptionFromRow(r);
    let signed = null;
    if (r.raw_data && typeof r.raw_data.amount === 'number' && !Number.isNaN(r.raw_data.amount)) {
      signed = r.raw_data.amount;
    } else if (typeof r.net_value === 'number' && r.net_value !== 0) {
      signed = r.net_value;
    } else {
      const g = Math.abs(parseFloat(r.gross_value) || 0);
      signed = r.payment_method === 'debito' ? -g : g;
    }
    return {
      entry_date: coerceBankDate(r.sale_date || r.raw_data?.date),
      description: desc,
      amount: Math.round(signed * 100) / 100,
      balance: r.balance != null ? parseFloat(r.balance) : null,
    };
  }).filter((t) => t.amount !== 0 && t.entry_date);
}

// POST /api/bank/:companyId/import — importa extrato OFX/CSV/imagem
router.post('/:companyId/import',
  authenticate, requireCompanyAccess, requirePermission('conciliacao'),
  upload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado' });
    const ext = req.file.originalname.split('.').pop().toLowerCase();

    try {
      let transactions = [];

      if (['jpg', 'jpeg', 'png', 'pdf', 'webp'].includes(ext)) {
        const result = await gemini.readBankStatement(req.file.buffer, req.file.mimetype);
        if (!result.success) return res.status(422).json({ error: result.error });
        transactions = (result.data.transactions || []).map((t) => {
          const raw = parseFloat(t.amount);
          const amount = Number.isFinite(raw) ? Math.round(raw * 100) / 100 : 0;
          const balRaw = t.balance != null ? parseFloat(t.balance) : null;
          const balance = balRaw != null && Number.isFinite(balRaw) ? Math.round(balRaw * 100) / 100 : null;
          return {
            entry_date: coerceBankDate(t.date),
            description: String(t.description || '—').slice(0, 300),
            amount,
            balance,
          };
        }).filter((t) => t.amount !== 0);
      } else {
        const rows = await importer.parse(req.file.buffer, req.file.originalname, req.file.mimetype);
        transactions = toBankTransactions(rows);
      }

      if (!transactions.length) {
        return res.status(400).json({
          error: 'Nenhuma linha válida no extrato. Use OFX, CSV com colunas de data/valor, ou imagem/PDF do extrato.',
        });
      }

      const dates = transactions.map((t) => t.entry_date).filter(Boolean).sort();
      const periodStart = dates[0] || new Date().toISOString().split('T')[0];
      const periodEnd = dates[dates.length - 1] || periodStart;

      const { data: stmt, error: stmtErr } = await supabase.from('bank_statements')
        .insert({
          company_id: req.companyId,
          bank_account: req.body.bankAccount || 'Importado',
          filename: req.file.originalname,
          imported_by: req.user.id,
          period_start: periodStart,
          period_end: periodEnd,
        })
        .select('id')
        .single();

      if (stmtErr || !stmt?.id) {
        logger.error('bank statement insert:', stmtErr);
        return res.status(500).json({ error: stmtErr?.message || 'Não foi possível registrar o extrato' });
      }

      const { data: cats } = await supabase.from('categories')
        .select('id,name,type')
        .or(`company_id.eq.${req.companyId},company_id.is.null`)
        .eq('active', true);
      const catList = cats || [];
      const catNames = catList.map((c) => c.name);
      const preferTypes = (amt) => (amt < 0 ? ['despesa', 'ambos'] : ['receita', 'ambos']);

      const inserted = [];
      for (let i = 0; i < transactions.length; i += 5) {
        const batch = transactions.slice(i, i + 5);
        await Promise.all(batch.map(async (t) => {
          const pref = preferTypes(t.amount);
          let catId = null;
          let aiSuggestion = null;

          const descTrim = String(t.description || '').trim();
          const ruleHint = descTrim.length >= 6 ? bankCategoryHint(t.description, t.amount) : null;
          if (ruleHint) {
            catId = matchCompanyCategoryId(catList, ruleHint, { preferTypes: pref });
            if (catId) aiSuggestion = ruleHint;
          }

          let suggestion = { category: null, confidence: 0 };
          if (!catId && descTrim.length >= 4 && catNames.length && process.env.GEMINI_API_KEY) {
            try {
              suggestion = await gemini.suggestCategory(t.description, t.amount, catNames);
            } catch (e) {
              logger.warn('suggestCategory skipped:', e.message);
            }
            const conf = Number(suggestion.confidence) || 0;
            const rawCat = suggestion.category;
            const catStr = rawCat != null && String(rawCat).trim().toLowerCase() !== 'null' ? String(rawCat).trim() : '';
            if (catStr && conf >= 0.58) {
              const matched = matchCompanyCategoryId(catList, catStr, { preferTypes: pref });
              if (matched) {
                aiSuggestion = catStr;
                catId = matched;
              }
            }
          }

          /* Mantém "pending" na lista padrão mesmo com categoria sugerida — evita "sumir" da aba Pendentes. */
          const safeCatId = categoryIdIfAllowed(catId, catList);
          const aiSafe = aiSuggestion != null ? String(aiSuggestion).trim().slice(0, 200) : null;
          const { data: entry, error: entErr } = await supabase.from('bank_entries').insert({
            company_id: req.companyId,
            statement_id: stmt.id,
            entry_date: coerceBankDate(t.entry_date),
            description: (t.description || '—').toString().slice(0, 300),
            amount: Number.isFinite(t.amount) ? t.amount : 0,
            balance: t.balance,
            category_id: safeCatId,
            ai_suggestion: aiSafe || null,
            status: 'pending',
          }).select('id').single();

          if (entErr) {
            logger.error('bank_entries insert:', entErr.message);
            throw new Error(entErr.message);
          }
          if (entry) inserted.push(entry.id);
        }));
      }

      res.json({
        message: `${inserted.length} lançamentos importados`,
        statementId: stmt.id,
        total: inserted.length,
      });
    } catch (err) {
      logger.error('Bank import error:', err);
      res.status(500).json({ error: err.message || 'Erro ao importar extrato' });
    }
  }
);

// GET /api/bank/:companyId/entries — lista entradas pendentes
router.get('/:companyId/entries',
  authenticate, requireCompanyAccess, requirePermission('conciliacao'),
  async (req, res) => {
    const { status = 'pending', statementId } = req.query;
    let q = supabase.from('bank_entries')
      .select('*, categories(id,name,color)')
      .eq('company_id', req.companyId)
      .order('entry_date', { ascending: false });

    if (status) q = q.eq('status', status);
    if (statementId) q = q.eq('statement_id', statementId);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ data });
  }
);

// PATCH /api/bank/:companyId/entries/:id/classify — classifica entrada
router.patch('/:companyId/entries/:id/classify',
  authenticate, requireCompanyAccess, requirePermission('conciliacao'),
  async (req, res) => {
    const { categoryId, payableId, status = 'classified' } = req.body;
    const { data: clsCats } = await supabase.from('categories')
      .select('id')
      .or(`company_id.eq.${req.companyId},company_id.is.null`)
      .eq('active', true);
    const safeCat = categoryIdIfAllowed(categoryId, clsCats || []);

    const { error } = await supabase.from('bank_entries')
      .update({ category_id: safeCat, payable_id: payableId || null, status })
      .eq('id', req.params.id).eq('company_id', req.companyId);

    if (error) return res.status(400).json({ error: error.message });
    res.json({ message: 'Classificado' });
  }
);

module.exports = router;
