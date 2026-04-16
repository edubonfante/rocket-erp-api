const router  = require('express').Router();
const multer  = require('multer');
const supabase = require('../db');
const gemini  = require('../services/geminiReader');
const salesImporter = require('../services/salesImporter');
const { authenticate, requireCompanyAccess, requirePermission } = require('../middlewares/auth');
const logger  = require('../utils/logger');
const { matchCompanyCategoryId } = require('../utils/categoryMatch');

function coercePgDate(val) {
  if (!val) return null;
  if (val instanceof Date && !Number.isNaN(val.getTime())) return val.toISOString().slice(0, 10);
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{2}\/\d{2}\/\d{4}/.test(s)) return `${s.slice(6, 10)}-${s.slice(3, 5)}-${s.slice(0, 2)}`;
  return null;
}

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

      // 3. Categorias da empresa (para casar nomes do Gemini com o plano de contas)
      const { data: uploadCatsRaw } = await supabase
        .from('categories')
        .select('id,name,type,company_id')
        .or(`company_id.eq.${req.companyId},company_id.is.null`)
        .eq('active', true);
      const uploadCats = uploadCatsRaw || [];

      let resolvedCategoryId = categoryId;
      if (!resolvedCategoryId && docData.suggested_category) {
        resolvedCategoryId = matchCompanyCategoryId(uploadCats, docData.suggested_category, { preferTypes: ['despesa', 'ambos'] });
      }

      // 4. Insere documento
      const detectedVal = salesImporter.parseMoneyBr(docData.total_value);
      const confirmedVal = confirmedValue != null && confirmedValue !== ''
        ? salesImporter.parseMoneyBr(confirmedValue)
        : detectedVal;
      const detectedDate = coercePgDate(docData.issue_date) || coercePgDate(docData.due_date) || new Date().toISOString().split('T')[0];

      const { data: doc, error: docErr } = await supabase
        .from('client_documents')
        .insert({
          company_id:      req.companyId,
          client_user_id:  req.user.id,
          file_url:        fileUrl,
          file_name:       req.file.originalname,
          doc_type:        docData.doc_type || 'outro',
          detected_value:  detectedVal,
          detected_date:   detectedDate,
          confirmed_value: confirmedVal,
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
              const mid = matchCompanyCategoryId(uploadCats, String(item.category), { preferTypes: ['despesa', 'ambos'] });
              if (mid) itemCategoryId = mid;
            }
            if (!itemCategoryId && (item.description || item.desc)) {
              const mid = matchCompanyCategoryId(uploadCats, String(item.description || item.desc), { preferTypes: ['despesa', 'ambos'] });
              if (mid) itemCategoryId = mid;
            }
            if (!itemCategoryId && docData.suggested_category) {
              const mid = matchCompanyCategoryId(uploadCats, String(docData.suggested_category), { preferTypes: ['despesa', 'ambos'] });
              if (mid) itemCategoryId = mid;
            }
            const itemGross = salesImporter.parseMoneyBr(item.total ?? (salesImporter.parseMoneyBr(item.unit_price) * (item.quantity || 1)));
            const itemDiscount = allocDiscount(itemGross);
            const itemNet = Math.max(itemGross - itemDiscount, 0);
            const rawPayA = item.payment_method ?? item.payment ?? item.forma_pagamento ?? item.pay_method;
            const itemPaymentA = rawPayA != null && String(rawPayA).trim() !== ''
              ? salesImporter.normalizePayment(rawPayA)
              : (docLevelPaymentAuto ? salesImporter.normalizePayment(docLevelPaymentAuto) : null);
            const itemDesc = (item.description != null && String(item.description).trim())
              ? String(item.description).trim()
              : 'Item';
            const { data: p, error: insErr } = await supabase
              .from('payables')
              .insert({
                company_id:  req.companyId,
                category_id: itemCategoryId,
                description: (docType + ' — ' + supplier + ' | ' + itemDesc).slice(0, 300),
                amount:      itemNet,
                due_date:    due,
                origin:      'document',
                origin_id:   doc.id,
                status:      'open',
                created_by:  req.user.id,
                supplier_name: supplier,
                item_description: itemDesc.slice(0, 300),
                payment_method: itemPaymentA,
                gross_amount: itemGross,
                discount_amount: itemDiscount,
                notes:       'NCM: ' + (item.ncm || '-') + ' | Qtd: ' + (item.quantity || 1) + ' | Gemini: ' + Math.round((docData.confidence||0)*100) + '%',
              })
              .select('id').single();
            if (insErr) throw new Error('Erro ao criar lançamento (item): ' + insErr.message);
            if (p) payables.push(p);
          }
          payable = payables[0];
          if (payable) {
            await supabase.from('client_documents')
              .update({ payable_id: payable.id, status: 'posted', reviewed_by: req.user.id, reviewed_at: new Date() })
              .eq('id', doc.id);
          }
        } else {
          const value = confirmedValue != null && confirmedValue !== ''
            ? salesImporter.parseMoneyBr(confirmedValue)
            : salesImporter.parseMoneyBr(docData.total_value);
          const gross = docData.subtotal != null
            ? (salesImporter.parseMoneyBr(docData.subtotal) || value)
            : (docData.total_value != null && docData.discount != null
              ? (salesImporter.parseMoneyBr(docData.total_value) + salesImporter.parseMoneyBr(docData.discount))
              : value);
          const disc = docData.discount != null ? salesImporter.parseMoneyBr(docData.discount) : 0;
          const singlePay = docData.payment_method
            ? salesImporter.normalizePayment(docData.payment_method)
            : null;
          const { data: p, error: singleErr } = await supabase
            .from('payables')
            .insert({
              company_id:  req.companyId,
              category_id: resolvedCategoryId,
              description: (docType + ' — ' + supplier).slice(0, 300),
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
          if (singleErr) throw new Error('Erro ao criar lançamento: ' + singleErr.message);
          payable = p;
          if (p) {
            await supabase.from('client_documents')
              .update({ payable_id: p.id, status: 'posted', reviewed_by: req.user.id, reviewed_at: new Date() })
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

      const launchOk = !!(payable && payable.id);
      res.json({
        document: { id: doc.id, file_url: fileUrl },
        gemini:   docData,
        payable,
        auto_posted: shouldPost && launchOk,
      });

    } catch (err) {
      logger.error('Document upload error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// GET /api/documents/:companyId/:documentId/payables — títulos gerados a partir do documento
router.get('/:companyId/:documentId/payables',
  authenticate, requireCompanyAccess, requirePermission('docs'),
  async (req, res) => {
    const { documentId } = req.params;
    const { data: doc, error: dErr } = await supabase
      .from('client_documents')
      .select('id,status,file_name,supplier_name,detected_value')
      .eq('id', documentId)
      .eq('company_id', req.companyId)
      .single();
    if (dErr || !doc) return res.status(404).json({ error: 'Documento não encontrado' });

    const { data: rows, error } = await supabase
      .from('payables')
      .select('*, categories(id,name)')
      .eq('company_id', req.companyId)
      .eq('origin', 'document')
      .eq('origin_id', documentId)
      .order('due_date', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ document: doc, payables: rows || [] });
  }
);

// POST /api/documents/:companyId/:documentId/revert-launch — cancela títulos em aberto e reabre o documento
router.post('/:companyId/:documentId/revert-launch',
  authenticate, requireCompanyAccess, requirePermission('docs'),
  async (req, res) => {
    const { documentId } = req.params;
    const { data: doc, error: dErr } = await supabase
      .from('client_documents')
      .select('id,status,payable_id')
      .eq('id', documentId)
      .eq('company_id', req.companyId)
      .single();
    if (dErr || !doc) return res.status(404).json({ error: 'Documento não encontrado' });

    const { data: pays, error: pErr } = await supabase
      .from('payables')
      .select('id,status')
      .eq('company_id', req.companyId)
      .eq('origin', 'document')
      .eq('origin_id', documentId);
    if (pErr) return res.status(500).json({ error: pErr.message });
    if (!pays?.length) return res.status(400).json({ error: 'Nenhum lançamento vinculado a este documento' });

    const paid = pays.filter((p) => p.status === 'paid');
    if (paid.length) {
      return res.status(400).json({
        error: 'Existe título já marcado como pago. Ajuste em Contas a Pagar antes de estornar o vínculo do documento.',
      });
    }

    const ids = pays.map((p) => p.id);
    await supabase.from('payables').update({ status: 'cancelled' }).in('id', ids).eq('company_id', req.companyId);

    await supabase
      .from('client_documents')
      .update({
        status: 'pending',
        payable_id: null,
        reviewed_by: null,
        reviewed_at: null,
      })
      .eq('id', documentId)
      .eq('company_id', req.companyId);

    await supabase.from('access_logs').insert({
      user_id: req.user.id,
      company_id: req.companyId,
      action: `Estorno de lançamentos do documento ${documentId} (${ids.length} títulos)`,
      module: 'docs',
      details: { documentId, payableIds: ids },
    });

    res.json({ message: `${ids.length} título(s) cancelado(s). Documento reaberto para novo lançamento.` });
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

    const { data: companyCatsRaw } = await supabase
      .from('categories')
      .select('id,name,type,company_id')
      .or(`company_id.eq.${req.companyId},company_id.is.null`)
      .eq('active', true);
    const companyCats = companyCatsRaw || [];

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
      resolvedCategoryId = matchCompanyCategoryId(companyCats, docData.suggested_category, { preferTypes: ['despesa', 'ambos'] });
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
        const mid = matchCompanyCategoryId(companyCats, String(catName), { preferTypes: ['despesa', 'ambos'] });
        if (mid) itemCategoryId = mid;
      }
      if (!itemCategoryId && (item.description || item.desc)) {
        const mid = matchCompanyCategoryId(companyCats, String(item.description || item.desc), { preferTypes: ['despesa', 'ambos'] });
        if (mid) itemCategoryId = mid;
      }
      if (!itemCategoryId && docData.suggested_category) {
        const mid = matchCompanyCategoryId(companyCats, String(docData.suggested_category), { preferTypes: ['despesa', 'ambos'] });
        if (mid) itemCategoryId = mid;
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
          description:      (docType + ' — ' + supplier + ' | ' + desc).slice(0, 300),
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
          .select('id, origin_id, categories(name)')
          .eq('company_id', req.companyId)
          .eq('origin', 'document')
          .in('origin_id', ids)
        : { data: [] };
      const firstPayByDoc = {};
      const firstCatByDoc = {};
      for (const p of payLinks || []) {
        if (!firstPayByDoc[p.origin_id]) firstPayByDoc[p.origin_id] = p.id;
        const cn = p.categories?.name;
        if (cn && firstCatByDoc[p.origin_id] == null) firstCatByDoc[p.origin_id] = cn;
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
        d.payable_category_name = firstCatByDoc[d.id] || null;
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
