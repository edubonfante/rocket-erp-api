const router  = require('express').Router();
const multer  = require('multer');
const supabase = require('../db');
const gemini  = require('../services/geminiReader');
const importer = require('../services/salesImporter');
const { authenticate, requireCompanyAccess, requirePermission } = require('../middlewares/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// POST /api/bank/:companyId/import — importa extrato OFX/CSV/imagem
router.post('/:companyId/import',
  authenticate, requireCompanyAccess, requirePermission('conciliacao'),
  upload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado' });
    const ext = req.file.originalname.split('.').pop().toLowerCase();

    let transactions = [];

    // Imagem de extrato → Gemini
    if (['jpg','jpeg','png','pdf'].includes(ext)) {
      const result = await gemini.readBankStatement(req.file.buffer, req.file.mimetype);
      if (!result.success) return res.status(422).json({ error: result.error });
      transactions = (result.data.transactions || []).map(t => ({
        entry_date:  t.date,
        description: t.description,
        amount:      t.amount,
        balance:     t.balance,
      }));
    } else {
      // OFX/CSV
      const rows = await importer.parse(req.file.buffer, req.file.originalname, req.file.mimetype);
      transactions = rows.map(r => ({
        entry_date:  r.sale_date,
        description: r.raw_data?.MEMO || r.raw_data?.description || '',
        amount:      r.gross_value * (r.payment_method === 'debito' ? -1 : 1),
      }));
    }

    // Cria statement
    const { data: stmt } = await supabase.from('bank_statements')
      .insert({
        company_id:  req.companyId,
        bank_account: req.body.bankAccount || 'Importado',
        filename:    req.file.originalname,
        imported_by: req.user.id,
        period_start: transactions.map(t=>t.entry_date).sort()[0],
        period_end:   transactions.map(t=>t.entry_date).sort().at(-1),
      }).select('id').single();

    // Busca categorias para sugestão IA
    const { data: cats } = await supabase.from('categories')
      .select('id,name').eq('company_id', req.companyId).eq('active', true);
    const catNames = (cats||[]).map(c => c.name);

    // Insere entradas com sugestão IA (em paralelo, limite 5)
    const inserted = [];
    for (let i = 0; i < transactions.length; i += 5) {
      const batch = transactions.slice(i, i + 5);
      await Promise.all(batch.map(async t => {
        // Sugestão de categoria
        const suggestion = t.description
          ? await gemini.suggestCategory(t.description, t.amount, catNames)
          : { category: null, confidence: 0 };

        const catId = suggestion.category
          ? cats?.find(c => c.name === suggestion.category)?.id
          : null;

        const { data: entry } = await supabase.from('bank_entries').insert({
          company_id:   req.companyId,
          statement_id: stmt.id,
          entry_date:   t.entry_date,
          description:  t.description,
          amount:       t.amount,
          balance:      t.balance,
          category_id:  catId,
          ai_suggestion: suggestion.category,
          status:       'pending',
        }).select('id').single();

        if (entry) inserted.push(entry.id);
      }));
    }

    res.json({
      message: `${inserted.length} lançamentos importados`,
      statementId: stmt.id,
      total: inserted.length,
    });
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

    if (status)      q = q.eq('status', status);
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
