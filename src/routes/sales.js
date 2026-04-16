const router   = require('express').Router();
const multer   = require('multer');
const supabase = require('../db');
const importer = require('../services/salesImporter');
const { authenticate, requireCompanyAccess, requirePermission } = require('../middlewares/auth');
const logger = require('../utils/logger');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const allowed = ['csv','xlsx','xls','json','xml','ofx','txt','pdf','jpg','jpeg','png','webp'];
    const ext = file.originalname.split('.').pop().toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

// POST /api/sales/:companyId/preview — prévia da importação (não salva)
router.post('/:companyId/preview',
  authenticate, requireCompanyAccess, requirePermission('vendas'),
  upload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado' });

    try {
      const rows = await importer.parse(req.file.buffer, req.file.originalname, req.file.mimetype);
      if (!rows.length) {
        return res.status(422).json({
          error: 'Nenhuma linha de venda reconhecida. Confira se há colunas de data e valor; em planilhas não padrão o sistema tenta interpretar com Gemini quando há GEMINI_API_KEY.',
        });
      }
      const summary = importer.summary(rows);
      const excelSheets = [...new Set(
        rows.map((r) => (r.raw_data && r.raw_data.__sheet) || null).filter(Boolean)
      )];
      const ext = req.file.originalname.split('.').pop().toLowerCase();
      const workbookTabs = ['xlsx', 'xls'].includes(ext)
        ? importer.listExcelSheetNames(req.file.buffer)
        : null;

      res.json({
        filename:   req.file.originalname,
        summary,
        preview:    rows.slice(0, 10),    // primeiras 10 linhas
        total_rows: rows.length,
        fieldMap:   Object.keys(rows[0] || {}),
        excel_sheets: excelSheets.length ? excelSheets : null,
        excel_workbook_tabs: workbookTabs && workbookTabs.length ? workbookTabs : null,
      });
    } catch (err) {
      logger.error('Import preview error:', err);
      res.status(400).json({ error: err.message });
    }
  }
);

// POST /api/sales/:companyId/import — importação definitiva
router.post('/:companyId/import',
  authenticate, requireCompanyAccess, requirePermission('vendas'),
  upload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado' });

    try {
      const rows    = await importer.parse(req.file.buffer, req.file.originalname, req.file.mimetype);
      const summary = importer.summary(rows);

      // Cria registro de importação
      const { data: importRecord, error: importErr } = await supabase
        .from('sale_imports')
        .insert({
          company_id:   req.companyId,
          filename:     req.file.originalname,
          file_type:    req.file.originalname.split('.').pop().toLowerCase(),
          record_count: rows.length,
          total_value:  summary.total_net,
          period_start: summary.period_start,
          period_end:   summary.period_end,
          imported_by:  req.user.id,
        })
        .select('id')
        .single();

      if (importErr || !importRecord?.id) {
        throw new Error(importErr?.message || 'Não foi possível registrar a importação no banco');
      }

      if (!rows.length) {
        throw new Error('Nenhuma linha válida para importar (verifique datas e valores).');
      }

      // Insere vendas em lotes de 500 (apenas colunas da tabela sales)
      const BATCH = 500;
      let inserted = 0;
      let lastBatchError = null;
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH).map(r => ({
          company_id:     req.companyId,
          import_id:      importRecord.id,
          sale_date:      r.sale_date,
          gross_value:    r.gross_value,
          discount:       r.discount ?? 0,
          net_value:      r.net_value,
          payment_method: r.payment_method,
          quantity:       r.quantity ?? 1,
          cancelled:      r.cancelled ?? false,
          raw_data:       r.raw_data ?? {},
        }));
        const { error } = await supabase.from('sales').insert(batch);
        if (error) {
          lastBatchError = error.message;
          logger.warn('Batch insert error:', error.message);
        } else inserted += batch.length;
      }
      if (inserted === 0 && lastBatchError) {
        throw new Error('Falha ao inserir vendas: ' + lastBatchError);
      }

      // Log
      await supabase.from('access_logs').insert({
        user_id: req.user.id, company_id: req.companyId,
        action: `Importou ${inserted} vendas de ${req.file.originalname}`,
        module: 'vendas', details: summary,
      });

      logger.info(`Vendas importadas: ${inserted} registros p/ empresa ${req.companyId}`);
      res.json({ message: `${inserted} vendas importadas com sucesso`, summary, importId: importRecord.id });

    } catch (err) {
      logger.error('Import error:', err);
      res.status(400).json({ error: err.message });
    }
  }
);

// GET /api/sales/:companyId — lista vendas
router.get('/:companyId',
  authenticate, requireCompanyAccess, requirePermission('vendas'),
  async (req, res) => {
    const { dateFrom, dateTo, paymentMethod, limit = 100, offset = 0 } = req.query;

    let query = supabase
      .from('sales')
      .select('*', { count: 'exact' })
      .eq('company_id', req.companyId)
      .order('sale_date', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (dateFrom)      query = query.gte('sale_date', dateFrom);
    if (dateTo)        query = query.lte('sale_date', dateTo);
    if (paymentMethod) query = query.eq('payment_method', paymentMethod);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ data, total: count });
  }
);

// GET /api/sales/:companyId/imports — histórico de importações
router.get('/:companyId/imports',
  authenticate, requireCompanyAccess, requirePermission('vendas'),
  async (req, res) => {
    const { data, error } = await supabase
      .from('sale_imports')
      .select('*, users(name)')
      .eq('company_id', req.companyId)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ data });
  }
);

module.exports = router;
