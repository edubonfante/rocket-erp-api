const router  = require('express').Router();
const multer  = require('multer');
const supabase = require('../db');
const gemini  = require('../services/geminiReader');
const importer = require('../services/salesImporter');
const { authenticate, requireCompanyAccess, requirePermission } = require('../middlewares/auth');
const logger = require('../utils/logger');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function toBankTransactions(rows) {
  const today = new Date().toISOString().split('T')[0];
  return (rows || []).map((r) => {
    const memo = r.memo || r.raw_data?.memo || r.raw_data?.MEMO || r.raw_data?.description || '';
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
      entry_date: r.sale_date && String(r.sale_date).slice(0, 10) ? String(r.sale_date).slice(0, 10) : today,
      description: String(memo || 'Movimentação').slice(0, 300),
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

      if (['jpg', 'jpeg', 'png', 'pdf'].includes(ext)) {
        const result = await gemini.readBankStatement(req.file.buffer, req.file.mimetype);
        if (!result.success) return res.status(422).json({ error: result.error });
        transactions = (result.data.transactions || []).map((t) => ({
          entry_date: (t.date && String(t.date).slice(0, 10)) || new Date().toISOString().split('T')[0],
          description: String(t.description || '—').slice(0, 300),
          amount: parseFloat(t.amount) || 0,
          balance: t.balance != null ? parseFloat(t.balance) : null,
        })).filter((t) => t.amount !== 0);
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
        .select('id,name').eq('company_id', req.companyId).eq('active', true);
      const catNames = (cats || []).map((c) => c.name);

      const inserted = [];
      for (let i = 0; i < transactions.length; i += 5) {
        const batch = transactions.slice(i, i + 5);
        await Promise.all(batch.map(async (t) => {
          let suggestion = { category: null, confidence: 0 };
          try {
            if (t.description && catNames.length) {
              suggestion = await gemini.suggestCategory(t.description, t.amount, catNames);
            }
          } catch (e) {
            logger.warn('suggestCategory skipped:', e.message);
          }

          const catId = suggestion.category
            ? cats?.find((c) => c.name === suggestion.category)?.id
            : null;

          const { data: entry, error: entErr } = await supabase.from('bank_entries').insert({
            company_id: req.companyId,
            statement_id: stmt.id,
            entry_date: t.entry_date,
            description: t.description || '—',
            amount: t.amount,
            balance: t.balance,
            category_id: catId,
            ai_suggestion: suggestion.category,
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
      .select('*, categories(name,color)')
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
    const { error } = await supabase.from('bank_entries')
      .update({ category_id: categoryId, payable_id: payableId, status })
      .eq('id', req.params.id).eq('company_id', req.companyId);

    if (error) return res.status(400).json({ error: error.message });
    res.json({ message: 'Classificado' });
  }
);

module.exports = router;
