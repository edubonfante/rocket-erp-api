const router  = require('express').Router();
const multer  = require('multer');
const supabase = require('../db');
const gemini  = require('../services/geminiReader');
const salesImporter = require('../services/salesImporter');
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
      // Items com categorias escolhidas pelo usuário (vem do frontend)
      let userItems = null;
      if (req.body.items) {
        try { userItems = JSON.parse(req.body.items); } catch(e) {}
      }

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
      if (!geminiResult.success) {
        await supabase.storage.from('rocket-erp-docs').remove([storagePath]);
        return res.status(422).json({
          error: 'Erro ao analisar a imagem',
          detail: geminiResult.error,
        });
      }
      const docData = geminiResult.data;

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

      // 5. Cria lançamentos POR ITEM se forcePost ou confiança >= 0.85
      let payable = null;
      const totalValNum = salesImporter.parseMoneyBr(docData.total_value);
      const shouldPost = forcePost === 'true' || (docData.confidence >= 0.85 && totalValNum > 0);

      if (shouldPost) {
        const items = (userItems && userItems.length > 0) ? userItems : (docData.items && docData.items.length > 0 ? docData.items : null);
        const due = confirmedDate || docData.due_date || docData.issue_date || new Date().toISOString().split('T')[0];
        const supplier = docData.supplier_name || req.file.originalname;
        const docType = (docData.doc_type || 'DOC').toUpperCase();
        const docLevelPaymentAuto = docData.payment_method || null;
        const totalDiscount = docData.discount != null ? salesImporter.parseMoneyBr(docData.discount) : 0;
        const itemGrossSum = Array.isArray(items) && items.length
          ? items.reduce((s, it) => s + salesImporter.parseMoneyBr(it.total ?? (salesImporter.parseMoneyBr(it.unit_price) * (it.quantity || 1))), 0)
          : 0;
        const allocDiscount = (gross) => {
          if (!totalDiscount || !itemGrossSum || !gross) return 0;
          const d = totalDiscount * (gross / itemGrossSum);
          return Math.round(d * 100) / 100;
        };

        if (items && items.length > 0) {
          // Lança um payable por item
          const payables = [];
          for (const item of items) {
            let itemCategoryId = resolvedCategoryId;
            if (item.category) {
              const { data: catData } = await supabase
                .from('categories')
                .select('id')
                .eq('company_id', req.companyId)
                .ilike('name', '%' + item.category + '%')
                .limit(1);
              if (catData?.[0]?.id) itemCategoryId = catData[0].id;
            }
            const itemGross = salesImporter.parseMoneyBr(item.total ?? (salesImporter.parseMoneyBr(item.unit_price) * (item.quantity || 1)));
            const itemDiscount = allocDiscount(itemGross);
            const itemNet = Math.max(itemGross - itemDiscount, 0);
            const rawPayA = item.payment_method ?? item.payment ?? item.forma_pagamento ?? item.pay_method;
            const itemPaymentA = rawPayA != null && String(rawPayA).trim() !== ''
              ? salesImporter.normalizePayment(rawPayA)
              : (docLevelPaymentAuto ? salesImporter.normalizePayment(docLevelPaymentAuto) : null);
            const { data: p } = await supabase
              .from('payables')
              .insert({
                company_id:  req.companyId,
                category_id: itemCategoryId,
                description: docType + ' — ' + supplier + ' | ' + item.description,
                amount:      itemNet,
                due_date:    due,
                origin:      'document',
                origin_id:   doc.id,
                status:      'open',
                created_by:  req.user.id,
                supplier_name: supplier,
                item_description: item.description || null,
                payment_method: itemPaymentA,
                gross_amount: itemGross,
                discount_amount: itemDiscount,
                notes:       'NCM: ' + (item.ncm || '-') + ' | Qtd: ' + (item.quantity || 1) + ' | Gemini: ' + Math.round((docData.confidence||0)*100) + '%',
              })
              .select('id').single();
            if (p) payables.push(p);
          }
          payable = payables[0];
          if (payable) {
            await supabase.from('client_documents')
              .update({ payable_id: payable.id, status: forcePost ? 'posted' : 'auto_posted', reviewed_by: req.user.id, reviewed_at: new Date() })
              .eq('id', doc.id);
          }
        } else {
          const value = confirmedValue ? parseFloat(confirmedValue) : docData.total_value;
          const gross = docData.subtotal != null
            ? (parseFloat(docData.subtotal) || value)
            : (docData.total_value != null && docData.discount != null
              ? (parseFloat(docData.total_value) + (parseFloat(docData.discount) || 0))
              : value);
          const disc = docData.discount != null ? (parseFloat(docData.discount) || 0) : 0;
          const singlePay = docData.payment_method
            ? salesImporter.normalizePayment(docData.payment_method)
            : null;
          const { data: p } = await supabase
            .from('payables')
            .insert({
              company_id:  req.companyId,
              category_id: resolvedCategoryId,
              description: docType + ' — ' + supplier,
              amount:      value,
              due_date:    due,
              origin:      'document',
              origin_id:   doc.id,
              status:      'open',
              created_by:  req.user.id,
              supplier_name: supplier,
              payment_method: singlePay,
              gross_amount: gross,
              discount_amount: disc,
              notes:       'Gemini: confianca ' + Math.round((docData.confidence || 0)*100) + '%',
            })
            .select('id').single();
          payable = p;
          if (p) {
            await supabase.from('client_documents')
              .update({ payable_id: p.id, status: forcePost ? 'posted' : 'auto_posted', reviewed_by: req.user.id, reviewed_at: new Date() })
              .eq('id', doc.id);
          }
        }
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

// POST /api/documents/:companyId/:documentId/launch-items
// Finaliza o mesmo documento criado no upload (evita segundo POST /upload que duplicava registro e deixava o primeiro "pendente").
router.post('/:companyId/:documentId/launch-items',
  authenticate, requireCompanyAccess, requirePermission('docs'),
  async (req, res) => {
    const { documentId } = req.params;
    const { confirmedValue, confirmedDate, categoryId, items } = req.body;

    let userItems = items;
    if (typeof userItems === 'string') {
      try { userItems = JSON.parse(userItems); } catch { userItems = []; }
    }
    if (!Array.isArray(userItems) || userItems.length === 0) {
      return res.status(400).json({ error: 'Informe ao menos um item para lançar' });
    }

    const { data: doc, error: docLoadErr } = await supabase
      .from('client_documents')
      .select('*')
      .eq('id', documentId)
      .eq('company_id', req.companyId)
      .single();

    if (docLoadErr || !doc) return res.status(404).json({ error: 'Documento não encontrado' });
    if (doc.status === 'posted' || doc.status === 'auto_posted') {
      return res.status(400).json({ error: 'Documento já lançado' });
    }

    const { data: existingPay } = await supabase
      .from('payables')
      .select('id')
      .eq('company_id', req.companyId)
      .eq('origin', 'document')
      .eq('origin_id', documentId);

    if (existingPay?.length) {
      await supabase
        .from('client_documents')
        .update({
          status:      'posted',
          payable_id:  existingPay[0].id,
          reviewed_by: req.user.id,
          reviewed_at: new Date(),
        })
        .eq('id', documentId);
      return res.json({ message: 'Lançamentos já vinculados a este documento.', payable: { id: existingPay[0].id } });
    }

    const docData = doc.gemini_data || {};
    let resolvedCategoryId = categoryId || doc.category_id;
    if (!resolvedCategoryId && docData.suggested_category) {
      const { data: cat } = await supabase
        .from('categories')
        .select('id')
        .eq('company_id', req.companyId)
        .ilike('name', `%${docData.suggested_category}%`)
        .single();
      resolvedCategoryId = cat?.id;
    }

    const due = confirmedDate || docData.due_date || docData.issue_date || new Date().toISOString().split('T')[0];
    const supplier = docData.supplier_name || doc.supplier_name || doc.file_name;
    const docType = (docData.doc_type || doc.doc_type || 'DOC').toUpperCase();
    const docLevelPayment = docData.payment_method || null;
    const totalDiscount = docData.discount != null ? salesImporter.parseMoneyBr(docData.discount) : 0;
    const itemGrossSum = userItems.reduce((s, it) => {
      const g = salesImporter.parseMoneyBr(it.total ?? (salesImporter.parseMoneyBr(it.unit_price) * (it.quantity || 1)));
      return s + g;
    }, 0);
    const allocDiscount = (gross) => {
      if (!totalDiscount || !itemGrossSum || !gross) return 0;
      return Math.round(totalDiscount * (gross / itemGrossSum) * 100) / 100;
    };

    const payables = [];
    for (const item of userItems) {
      let itemCategoryId = resolvedCategoryId;
      const catName = item.category || item.catName;
      if (catName) {
        const { data: catData } = await supabase
          .from('categories')
          .select('id')
          .eq('company_id', req.companyId)
          .ilike('name', '%' + String(catName) + '%')
          .limit(1);
        if (catData?.[0]?.id) itemCategoryId = catData[0].id;
      }
      if (item.category_id) itemCategoryId = item.category_id;

      const itemGross = salesImporter.parseMoneyBr(item.total ?? (salesImporter.parseMoneyBr(item.unit_price) * (item.quantity || 1)));
      const itemDiscount = allocDiscount(itemGross);
      const itemNet = Math.max(itemGross - itemDiscount, 0);
      const desc = (item.description || 'Item').toString();
      const rawPay = item.payment_method ?? item.payment ?? item.forma_pagamento ?? item.pay_method;
      const itemPayment = rawPay != null && String(rawPay).trim() !== ''
        ? salesImporter.normalizePayment(rawPay)
        : (docLevelPayment ? salesImporter.normalizePayment(docLevelPayment) : null);

      const { data: p, error: pErr } = await supabase
        .from('payables')
        .insert({
          company_id:       req.companyId,
          category_id:      itemCategoryId,
          description:      docType + ' — ' + supplier + ' | ' + desc,
          amount:           itemNet,
          due_date:         due,
          origin:           'document',
          origin_id:        documentId,
          status:           'open',
          created_by:       req.user.id,
          supplier_name:    supplier,
          item_description: desc,
          payment_method:   itemPayment,
          gross_amount:     itemGross,
          discount_amount:  itemDiscount,
          notes:            'NCM: ' + (item.ncm || '-') + ' | Qtd: ' + (item.quantity || 1) + ' | doc:' + documentId,
        })
        .select('id')
        .single();

      if (pErr) {
        logger.error('launch-items payable insert:', pErr.message);
        return res.status(400).json({ error: 'Erro ao criar lançamento: ' + pErr.message });
      }
      if (p) payables.push(p);
    }

    const first = payables[0];
    await supabase
      .from('client_documents')
      .update({
        confirmed_value: confirmedValue != null ? parseFloat(confirmedValue) : doc.detected_value,
        status:          'posted',
        payable_id:      first?.id,
        reviewed_by:     req.user.id,
        reviewed_at:     new Date(),
      })
      .eq('id', documentId);

    await supabase.from('access_logs').insert({
      user_id: req.user.id,
      company_id: req.companyId,
      action: `Lançamento por item: doc ${documentId} (${payables.length} títulos)`,
      module: 'docs',
      details: { documentId, count: payables.length },
    });

    res.json({ message: `${payables.length} itens lançados`, payable: first, payables });
  }
);

// GET /api/documents/:companyId — lista documentos
router.get('/:companyId',
  authenticate, requireCompanyAccess, requirePermission('docs'),
  async (req, res) => {
    const { status, limit = 200, offset = 0 } = req.query;

    let query = supabase
      .from('client_documents')
      .select('*, users!client_user_id(name)', { count: 'exact' })
      .eq('company_id', req.companyId)
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (status) query = query.eq('status', status);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const docRows = data || [];
    const postedLike = (s) => ['posted', 'auto_posted', 'lancado'].includes(String(s || '').toLowerCase());
    if (docRows.length) {
      const ids = docRows.map((d) => d.id);
      const { data: payLinks } = ids.length
        ? await supabase
          .from('payables')
          .select('id, origin_id')
          .eq('company_id', req.companyId)
          .eq('origin', 'document')
          .in('origin_id', ids)
        : { data: [] };
      const firstPayByDoc = {};
      for (const p of payLinks || []) {
        if (!firstPayByDoc[p.origin_id]) firstPayByDoc[p.origin_id] = p.id;
      }
      const fixes = [];
      for (const d of docRows) {
        const pid = firstPayByDoc[d.id];
        const st = String(d.status || '').toLowerCase();
        if (pid && !postedLike(st) && st !== 'rejected') {
          fixes.push(
            supabase
              .from('client_documents')
              .update({ status: 'posted', payable_id: d.payable_id || pid })
              .eq('id', d.id)
              .eq('company_id', req.companyId)
          );
        }
      }
      if (fixes.length) await Promise.all(fixes);
      for (const d of docRows) {
        const pid = firstPayByDoc[d.id];
        const st = String(d.status || '').toLowerCase();
        if (pid && !postedLike(st) && st !== 'rejected') {
          d.status = 'posted';
          d.payable_id = d.payable_id || pid;
        }
      }
      for (const d of docRows) {
        const pid = firstPayByDoc[d.id];
        const st = String(d.status || '').toLowerCase();
        d.has_launch = postedLike(st) || !!pid;
      }
    }

    res.json({ data: docRows, total: count });
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
    if (doc.status === 'posted' || doc.status === 'auto_posted' || doc.payable_id)
      return res.status(400).json({ error: 'Documento já lançado' });

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
        supplier_name: doc.supplier_name || null,
        payment_method: doc.gemini_data?.payment_method || null,
        gross_amount: doc.gemini_data?.subtotal ?? (doc.gemini_data?.total_value != null && doc.gemini_data?.discount != null
          ? (parseFloat(doc.gemini_data.total_value) + parseFloat(doc.gemini_data.discount))
          : (doc.gemini_data?.total_value ?? null)),
        discount_amount: doc.gemini_data?.discount ?? 0,
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
