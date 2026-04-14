const router  = require('express').Router();
const multer  = require('multer');
const supabase = require('../db');
const gemini  = require('../services/geminiReader');
const { authenticate, requireCompanyAccess, requirePermission } = require('../middlewares/auth');
const logger  = require('../utils/logger');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (_, file, cb) => {
    const ok = ['image/jpeg','image/png','image/webp','image/heic','application/pdf'];
    cb(null, ok.includes(file.mimetype));
  }
});

// POST /api/documents/:companyId/analyze
// Recebe foto, chama Gemini e retorna dados extraídos (sem salvar)
router.post('/:companyId/analyze',
  authenticate, requireCompanyAccess,
  upload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Imagem não enviada' });

    const result = await gemini.readDocument(req.file.buffer, req.file.mimetype);
    if (!result.success)
      return res.status(422).json({ error: 'Não foi possível ler o documento', detail: result.error });

    res.json(result.data);
  }
);

// POST /api/documents/:companyId/upload
// Upload + Gemini + salva no banco + cria lançamento se confiança alta
router.post('/:companyId/upload',
  authenticate, requireCompanyAccess, requirePermission('docs'),
  upload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado' });

    const { categoryId, forcePost, confirmedValue, confirmedDate } = req.body;

    try {
      // 1. Upload para Supabase Storage
      const storagePath = `documents/${req.companyId}/${Date.now()}_${req.file.originalname}`;
      const { error: uploadErr } = await supabase.storage
        .from('rocket-erp-docs')
        .upload(storagePath, req.file.buffer, { contentType: req.file.mimetype });

      if (uploadErr) throw new Error('Erro no upload: ' + uploadErr.message);

      const fileUrl = supabase.storage.from('rocket-erp-docs').getPublicUrl(storagePath).data.publicUrl;

      // 2. Lê com Gemini
      const geminiResult = await gemini.readDocument(req.file.buffer, req.file.mimetype);
      const docData = geminiResult.success ? geminiResult.data : {};

      // 3. Resolve categoria
      let resolvedCategoryId = categoryId;
      if (!resolvedCategoryId && docData.suggested_category) {
        const { data: cat } = await supabase
          .from('categories')
          .select('id')
          .eq('company_id', req.companyId)
          .ilike('name', `%${docData.suggested_category}%`)
          .single();
        resolvedCategoryId = cat?.id;
      }

      // 4. Insere documento
      const { data: doc, error: docErr } = await supabase
        .from('client_documents')
        .insert({
          company_id:      req.companyId,
          client_user_id:  req.user.id,
          file_url:        fileUrl,
          file_name:       req.file.originalname,
          doc_type:        docData.doc_type || 'outro',
          detected_value:  docData.total_value,
          detected_date:   docData.issue_date,
          confirmed_value: confirmedValue ? parseFloat(confirmedValue) : docData.total_value,
          supplier_name:   docData.supplier_name,
          supplier_cnpj:   docData.supplier_cnpj,
          category_id:     resolvedCategoryId,
          gemini_data:     docData,
          confidence:      docData.confidence || 0,
          status:          'pending',
          notes:           req.body.notes || null,
        })
        .select('id').single();

      if (docErr) throw new Error(docErr.message);

      // 5. Cria lançamento se forcePost ou confiança >= 0.85
      let payable = null;
      const shouldPost = forcePost === 'true' || (docData.confidence >= 0.85 && docData.total_value > 0);

      if (shouldPost) {
        const value = confirmedValue ? parseFloat(confirmedValue) : docData.total_value;
        const { data: p } = await supabase
          .from('payables')
          .insert({
            company_id:  req.companyId,
            category_id: resolvedCategoryId,
            description: `${(docData.doc_type || 'DOC').toUpperCase()} — ${docData.supplier_name || req.file.originalname}`,
            amount:      value,
            due_date:    confirmedDate || docData.due_date || docData.issue_date || new Date().toISOString().split('T')[0],
            origin:      'document',
            origin_id:   doc.id,
            status:      'open',
            created_by:  req.user.id,
            notes:       `Gemini: confiança ${Math.round((docData.confidence || 0)*100)}%`,
          })
          .select('id').single();

        payable = p;

        await supabase
          .from('client_documents')
          .update({ payable_id: p.id, status: forcePost ? 'posted' : 'auto_posted', reviewed_by: req.user.id, reviewed_at: new Date() })
          .eq('id', doc.id);
      }

      // Log
      await supabase.from('access_logs').insert({
        user_id: req.user.id, company_id: req.companyId,
        action: `Upload de documento: ${req.file.originalname}`,
        module: 'docs',
        details: { docId: doc.id, value: docData.total_value, confidence: docData.confidence, auto_posted: shouldPost },
      });

      res.json({
        document: { id: doc.id, file_url: fileUrl },
        gemini:   docData,
        payable,
        auto_posted: shouldPost,
      });

    } catch (err) {
      logger.error('Document upload error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// GET /api/documents/:companyId — lista documentos
router.get('/:companyId',
  authenticate, requireCompanyAccess, requirePermission('docs'),
  async (req, res) => {
    const { status, limit = 50, offset = 0 } = req.query;

    let query = supabase
      .from('client_documents')
      .select('*, users!client_user_id(name), categories(name)', { count: 'exact' })
      .eq('company_id', req.companyId)
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (status) query = query.eq('status', status);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ data, total: count });
  }
);

// PATCH /api/documents/:companyId/:id/confirm
// Operador confirma dados do documento e cria lançamento
router.patch('/:companyId/:id/confirm',
  authenticate, requireCompanyAccess, requirePermission('docs'),
  async (req, res) => {
    const { confirmedValue, confirmedDate, categoryId, notes } = req.body;
    const { id } = req.params;

    const { data: doc } = await supabase
      .from('client_documents').select('*').eq('id', id).eq('company_id', req.companyId).single();

    if (!doc) return res.status(404).json({ error: 'Documento não encontrado' });
    if (doc.status === 'posted') return res.status(400).json({ error: 'Documento já lançado' });

    // Cria conta a pagar
    const { data: payable } = await supabase
      .from('payables')
      .insert({
        company_id:  req.companyId,
        category_id: categoryId || doc.category_id,
        description: `${(doc.doc_type||'DOC').toUpperCase()} — ${doc.supplier_name || doc.file_name}`,
        amount:      confirmedValue || doc.detected_value,
        due_date:    confirmedDate || doc.detected_date || new Date().toISOString().split('T')[0],
        origin:      'document',
        origin_id:   doc.id,
        status:      'open',
        created_by:  req.user.id,
        notes,
      })
      .select('id').single();

    await supabase
      .from('client_documents')
      .update({
        confirmed_value: confirmedValue,
        status:          'posted',
        payable_id:      payable.id,
        reviewed_by:     req.user.id,
        reviewed_at:     new Date(),
        notes,
      })
      .eq('id', id);

    res.json({ message: 'Documento lançado com sucesso', payable });
  }
);

// POST /api/documents/:companyId/drive-scan
// Aciona scan manual da pasta do Drive
router.post('/:companyId/drive-scan',
  authenticate, requireCompanyAccess, requirePermission('docs'),
  async (req, res) => {
    const driveMonitor = require('../services/driveMonitor');
    const { data: company } = await supabase
      .from('companies').select('*').eq('id', req.companyId).single();

    if (!company?.drive_folder_id)
      return res.status(400).json({ error: 'Pasta do Google Drive não configurada' });

    // Executa em background
    driveMonitor.scanCompany(company).catch(err => logger.error('Drive scan error:', err.message));

    res.json({ message: 'Scan do Drive iniciado em background' });
  }
);

module.exports = router;
