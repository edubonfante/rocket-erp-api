const router  = require('express').Router();
const multer  = require('multer');
const supabase = require('../db');
const gemini  = require('../services/geminiReader');
const salesImporter = require('../services/salesImporter');
const { authenticate, requireCompanyAccess, requirePermission } = require('../middlewares/auth');
const logger  = require('../utils/logger');
const {
  matchCompanyCategoryId,
  categoryIdIsComprasOuFreteGenerico,
  docItemsSuggestRetailStock,
  labelLooksLikeRetailStockLine,
} = require('../utils/categoryMatch');
const {
  categoryIdIfAllowed,
  payableCategoryIdOrFallback,
  pickFallbackExpenseCategoryId,
} = require('../utils/categoryIdSafe');
const { signRocketDocUrl } = require('../utils/storageSignedUrl');
const {
  enrichGeminiDocItemsWithNcmReference,
  applyDominantCategoryFromItems,
} = require('../services/ncmCategoryLookup');

function coercePgDate(val) {
  if (!val) return null;
  if (val instanceof Date && !Number.isNaN(val.getTime())) return val.toISOString().slice(0, 10);
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{2}\/\d{2}\/\d{4}/.test(s)) return `${s.slice(6, 10)}-${s.slice(3, 5)}-${s.slice(0, 2)}`;
  return null;
}

/** due_date em payables: sempre ISO; Gemini/UI podem mandar DD/MM/AAAA. */
function dueDateForPayable(confirmedDate, docData, fallbackRaw) {
  const raw = confirmedDate || docData?.due_date || docData?.issue_date;
  return coercePgDate(raw) || coercePgDate(fallbackRaw) || new Date().toISOString().split('T')[0];
}

/** Evita NaN/undefined no JSONB e valores que quebram o insert no Postgres. */
function jsonSafeForPostgres(value) {
  if (value == null) return null;
  if (typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value, (_, v) => {
      if (v === undefined) return null;
      if (typeof v === 'number' && !Number.isFinite(v)) return null;
      return v;
    }));
  } catch {
    return {};
  }
}

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

function formatClientDocumentsInsertError(docErr) {
  const m = docErr?.message || String(docErr);
  if (/schema cache|PGRST204|Could not find the 'category_id' column of 'client_documents'/i.test(m)) {
    return (
      'O PostgREST do Supabase ainda não enxerga a coluna category_id em client_documents. '
      + 'No painel do MESMO projeto do SUPABASE_URL da API (ex.: Cloud Run → variáveis): abra SQL Editor, '
      + 'rode o arquivo supabase/migrations/006_client_documents_api_columns.sql (com ALTER TABLE … e no final NOTIFY pgrst). '
      + 'No terminal: cd backend && npm run db:apply-006 (precisa SUPABASE_DB_PASSWORD no .env). '
      + 'Detalhe técnico: ' + m
    );
  }
  return m;
}

/** Reduz JSONB gigante (raw_text/itens) — evita OOM e payloads que derrubam o Node em hosts pequenos (Railway). */
function trimGeminiDocForPayload(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const o = { ...obj };
  if (typeof o.raw_text === 'string' && o.raw_text.length > 225000) {
    o.raw_text = `${o.raw_text.slice(0, 225000)}\n…[truncado — limite do servidor]`;
  }
  if (typeof o.observations === 'string' && o.observations.length > 20000) {
    o.observations = o.observations.slice(0, 20000);
  }
  if (Array.isArray(o.items) && o.items.length > 1250) {
    o.items = o.items.slice(0, 1250);
  }
  return o;
}

const upload = multer({
  storage: multer.memoryStorage(),
  /* Railway e similares: PDF+Gemini duplicam memória (buffer + base64); 15MB reduz risco de OOM. */
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const m = String(file.mimetype || '').toLowerCase().split(';')[0].trim();
    const ok = ['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
    if (ok.includes(m)) return cb(null, true);
    /* Android/câmera às vezes manda octet-stream com extensão de imagem */
    if (m === 'application/octet-stream' && /\.(jpe?g|png|webp|heic|heif|pdf)$/i.test(file.originalname || '')) {
      return cb(null, true);
    }
    cb(null, false);
  }
});

// POST /api/documents/:companyId/analyze
// Recebe foto, chama Gemini e retorna dados extraídos (sem salvar)
router.post('/:companyId/analyze',
  authenticate, requireCompanyAccess,
  upload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Imagem não enviada' });

    try {
      const { data: analyzeCats } = await supabase
        .from('categories')
        .select('name,type')
        .or(`company_id.eq.${req.companyId},company_id.is.null`)
        .eq('active', true);
      const expenseNames = (analyzeCats || [])
        .filter((c) => !c.type || ['despesa', 'ambos', 'custo', 'receita', 'imposto', 'financeiro', 'variavel', 'investimento', 'saida', 'deducao'].includes(c.type))
        .map((c) => c.name);
      const result = await gemini.readDocument(req.file.buffer, req.file.mimetype, req.file.originalname, {
        expenseCategoryNames: expenseNames,
      });
      if (!result.success) {
        const msg = result.error || 'Não foi possível ler o documento';
        return res.status(422).json({ error: msg, detail: msg });
      }
      try {
        result.data = applyDominantCategoryFromItems(
          await enrichGeminiDocItemsWithNcmReference(result.data),
        );
      } catch (ncmErr) {
        logger.warn('Document analyze: enriquecimento NCM ignorado:', ncmErr.message);
      }
      res.json(result.data);
    } catch (err) {
      const em = (err?.message || String(err) || 'Erro ao analisar documento').trim().slice(0, 800);
      logger.error('Document analyze error:', em);
      if (!res.headersSent) {
        res.status(500).json({ error: em, detail: em });
      }
    }
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

    let storagePath = null;
    try {
      const { data: uploadCatsRaw } = await supabase
        .from('categories')
        .select('id,name,type,company_id')
        .or(`company_id.eq.${req.companyId},company_id.is.null`)
        .eq('active', true);
      const uploadCats = uploadCatsRaw || [];
      const expenseNames = uploadCats
        .filter((c) => !c.type || ['despesa', 'ambos', 'custo', 'receita', 'imposto', 'financeiro', 'variavel', 'investimento', 'saida', 'deducao'].includes(c.type))
        .map((c) => c.name);

      // 1. Gemini primeiro (falha rápido; evita arquivo órfão no Storage se a leitura quebrar)
      const geminiResult = await gemini.readDocument(req.file.buffer, req.file.mimetype, req.file.originalname, {
        expenseCategoryNames: expenseNames,
      });
      if (!geminiResult.success) {
        const ge = geminiResult.error || 'Falha na leitura do documento';
        return res.status(422).json({
          error: ge,
          detail: ge,
        });
      }
      let docData = geminiResult.data;
      try {
        docData = applyDominantCategoryFromItems(
          await enrichGeminiDocItemsWithNcmReference(docData),
        );
      } catch (ncmErr) {
        logger.warn('Document upload: enriquecimento NCM ignorado:', ncmErr.message);
      }

      // 2. Upload para Supabase Storage
      storagePath = `documents/${req.companyId}/${Date.now()}_${req.file.originalname}`;
      const storageMime = gemini.normalizeMimeType(req.file.mimetype, req.file.originalname);
      const { error: uploadErr } = await supabase.storage
        .from('rocket-erp-docs')
        .upload(storagePath, req.file.buffer, { contentType: storageMime });

      if (uploadErr) throw new Error('Erro no upload: ' + uploadErr.message);

      const fileUrlPublic = supabase.storage.from('rocket-erp-docs').getPublicUrl(storagePath).data.publicUrl;

      let fileUrlSigned = fileUrlPublic;
      try {
        const s = await signRocketDocUrl(fileUrlPublic);
        if (s) fileUrlSigned = s;
      } catch (signErr) {
        logger.warn('Document upload: URL assinada indisponível, usando URL pública.', signErr.message);
      }

      const geminiPayload = jsonSafeForPostgres(trimGeminiDocForPayload(docData)) || {};

      // 3. Categorias já carregadas antes do Gemini (uploadCats)

      const docMatchOpts = {
        preferTypes: ['despesa', 'ambos'],
        deemphasizeTaxExpenseCategories: true,
        excludeComprasFreteForStockLines: true,
      };
      let resolvedCategoryId = categoryIdIfAllowed(categoryId, uploadCats);
      /* Itens / NCM antes do suggested_category do documento — evita “Compras e fretes” genérico sobre NF de mercadoria. */
      if (!resolvedCategoryId && Array.isArray(docData.items) && docData.items.length) {
        for (const it of docData.items) {
          const ref = it.ncm_category_reference != null && String(it.ncm_category_reference).trim() !== ''
            ? String(it.ncm_category_reference).trim()
            : null;
          if (ref) {
            const mid = matchCompanyCategoryId(uploadCats, ref, docMatchOpts);
            if (mid) {
              resolvedCategoryId = mid;
              break;
            }
          }
          const catLab = it.category != null && String(it.category).trim() !== '' ? String(it.category).trim() : null;
          if (catLab) {
            const mid = matchCompanyCategoryId(uploadCats, catLab, docMatchOpts);
            if (mid) {
              resolvedCategoryId = mid;
              break;
            }
          }
          const lineCtx = [
            docData.supplier_name,
            it.description,
            it.desc,
            it.ncm ? `NCM ${String(it.ncm).replace(/\D/g, '')}` : null,
          ]
            .filter((x) => x != null && String(x).trim() !== '')
            .join(' | ');
          if (lineCtx.trim()) {
            const mid = matchCompanyCategoryId(uploadCats, lineCtx, docMatchOpts);
            if (mid) {
              resolvedCategoryId = mid;
              break;
            }
          }
        }
      }
      if (!resolvedCategoryId && docData.suggested_category != null && docData.suggested_category !== '') {
        const sugId = matchCompanyCategoryId(uploadCats, String(docData.suggested_category), docMatchOpts);
        if (sugId && !(categoryIdIsComprasOuFreteGenerico(uploadCats, sugId) && docItemsSuggestRetailStock(docData))) {
          resolvedCategoryId = sugId;
        }
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
          file_url:        fileUrlPublic,
          file_name:       String(req.file.originalname || 'arquivo').slice(0, 200),
          doc_type:        String(docData.doc_type || 'outro').slice(0, 50),
          detected_value:  detectedVal,
          detected_date:   detectedDate,
          confirmed_value: confirmedVal,
          supplier_name:   docData.supplier_name != null ? String(docData.supplier_name).slice(0, 200) : null,
          supplier_cnpj:   docData.supplier_cnpj != null ? String(docData.supplier_cnpj).slice(0, 18) : null,
          category_id:     categoryIdIfAllowed(resolvedCategoryId, uploadCats),
          gemini_data:     geminiPayload,
          confidence:      clamp01(docData.confidence),
          status:          'pending',
          notes:           req.body.notes != null ? String(req.body.notes).slice(0, 5000) : null,
        })
        .select('id').single();

      if (docErr) throw new Error(formatClientDocumentsInsertError(docErr));

      // 5. Cria lançamentos POR ITEM se forcePost ou confiança >= 0.85
      let payable = null;
      const totalValNum = salesImporter.parseMoneyBr(docData.total_value);
      let shouldPost = forcePost === 'true' || (clamp01(docData.confidence) >= 0.85 && totalValNum > 0);
      if (shouldPost && !pickFallbackExpenseCategoryId(uploadCats)) {
        logger.warn('Document upload: lançamento automático ignorado — empresa sem categorias de despesa.');
        shouldPost = false;
      }

      if (shouldPost) {
        let items = (userItems && userItems.length > 0) ? userItems : (docData.items && docData.items.length > 0 ? docData.items : null);
        if (items && items.length) {
          try {
            const er = await enrichGeminiDocItemsWithNcmReference({ items });
            if (Array.isArray(er?.items)) items = er.items;
          } catch (e) {
            logger.warn('Document upload (auto-post): NCM enrich nos itens ignorado:', e.message);
          }
        }
        const due = dueDateForPayable(confirmedDate, docData, detectedDate);
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
          const docConf = clamp01(docData.confidence);
          const matchOpts = docMatchOpts;
          for (const item of items) {
            let itemCategoryId = resolvedCategoryId;
            /* Não use (category_id || catId): um category_id inválido do Gemini “oculta” o catId escolhido no app. */
            const exUp = categoryIdIfAllowed(item.catId, uploadCats)
              || categoryIdIfAllowed(item.categoryId, uploadCats)
              || categoryIdIfAllowed(item.category_id, uploadCats);
            if (exUp) itemCategoryId = exUp;
            else if (item.ncm_category_reference) {
              const mid = matchCompanyCategoryId(uploadCats, String(item.ncm_category_reference), matchOpts);
              if (mid) itemCategoryId = mid;
            } else if (item.category) {
              const mid = matchCompanyCategoryId(uploadCats, String(item.category), matchOpts);
              if (mid) itemCategoryId = mid;
            }
            const lineContext = [
              docData.supplier_name,
              item.description || item.desc,
              item.ncm ? `NCM ${String(item.ncm).replace(/\D/g, '')}` : null,
              item.ncm_category_reference,
              item.category,
            ]
              .filter((x) => x != null && String(x).trim() !== '')
              .join(' | ');
            if (!itemCategoryId && lineContext.trim()) {
              const mid = matchCompanyCategoryId(uploadCats, lineContext, matchOpts);
              if (mid) itemCategoryId = mid;
            }
            if (
              !itemCategoryId
              && docData.suggested_category != null
              && docData.suggested_category !== ''
              && docConf >= 0.52
            ) {
              const mid = matchCompanyCategoryId(uploadCats, String(docData.suggested_category), matchOpts);
              if (
                mid
                && !(categoryIdIsComprasOuFreteGenerico(uploadCats, mid) && labelLooksLikeRetailStockLine(lineContext))
              ) {
                itemCategoryId = mid;
              }
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
                category_id: payableCategoryIdOrFallback(itemCategoryId, uploadCats),
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
          let singleCategoryId = resolvedCategoryId;
          if (!singleCategoryId && Array.isArray(docData.items) && docData.items.length) {
            for (const it of docData.items) {
              const ctx = [
                docData.supplier_name,
                it.description,
                it.desc,
                it.ncm ? `NCM ${String(it.ncm).replace(/\D/g, '')}` : null,
                it.ncm_category_reference,
                it.category,
              ]
                .filter((x) => x != null && String(x).trim() !== '')
                .join(' | ');
              if (!ctx.trim()) continue;
              const mid = matchCompanyCategoryId(uploadCats, ctx, docMatchOpts);
              if (mid) {
                singleCategoryId = mid;
                break;
              }
            }
          }
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
              category_id: payableCategoryIdOrFallback(singleCategoryId, uploadCats),
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
        document: { id: doc.id, file_url: fileUrlSigned },
        gemini:   docData,
        payable,
        auto_posted: shouldPost && launchOk,
      });

    } catch (err) {
      const em = (err?.message || String(err) || 'Erro ao processar documento').trim().slice(0, 800);
      logger.error(`Document upload error: ${em}`);
      if (storagePath) {
        supabase.storage.from('rocket-erp-docs').remove([storagePath]).catch((e) => {
          logger.warn('Document upload: falha ao remover arquivo após erro:', e.message);
        });
      }
      if (!res.headersSent) {
        res.status(500).json({ error: em, detail: em });
      }
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
    if (!pickFallbackExpenseCategoryId(companyCats)) {
      return res.status(400).json({
        error: 'Cadastre ao menos uma categoria de despesa nesta empresa antes de lançar itens do documento.',
      });
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
    const matchOptsLaunch = {
      preferTypes: ['despesa', 'ambos'],
      deemphasizeTaxExpenseCategories: true,
      excludeComprasFreteForStockLines: true,
    };
    let resolvedCategoryId = categoryIdIfAllowed(categoryId, companyCats) || categoryIdIfAllowed(doc.category_id, companyCats);
    if (!resolvedCategoryId && Array.isArray(docData.items) && docData.items.length) {
      for (const it of docData.items) {
        const ref = it.ncm_category_reference != null && String(it.ncm_category_reference).trim() !== ''
          ? String(it.ncm_category_reference).trim()
          : null;
        if (ref) {
          const mid = matchCompanyCategoryId(companyCats, ref, matchOptsLaunch);
          if (mid) {
            resolvedCategoryId = mid;
            break;
          }
        }
        const catLab = it.category != null && String(it.category).trim() !== '' ? String(it.category).trim() : null;
        if (catLab) {
          const mid = matchCompanyCategoryId(companyCats, catLab, matchOptsLaunch);
          if (mid) {
            resolvedCategoryId = mid;
            break;
          }
        }
        const lineCtx0 = [
          docData.supplier_name,
          it.description,
          it.desc,
          it.ncm ? `NCM ${String(it.ncm).replace(/\D/g, '')}` : null,
        ]
          .filter((x) => x != null && String(x).trim() !== '')
          .join(' | ');
        if (lineCtx0.trim()) {
          const mid = matchCompanyCategoryId(companyCats, lineCtx0, matchOptsLaunch);
          if (mid) {
            resolvedCategoryId = mid;
            break;
          }
        }
      }
    }
    if (!resolvedCategoryId && docData.suggested_category != null && docData.suggested_category !== '') {
      const sugId = matchCompanyCategoryId(companyCats, String(docData.suggested_category), matchOptsLaunch);
      if (sugId && !(categoryIdIsComprasOuFreteGenerico(companyCats, sugId) && docItemsSuggestRetailStock(docData))) {
        resolvedCategoryId = sugId;
      }
    }

    const due = dueDateForPayable(confirmedDate, docData, doc.detected_date);
    const supplier = docData.supplier_name || doc.supplier_name || doc.file_name;
    const docType = (docData.doc_type || doc.doc_type || 'DOC').toUpperCase();
    const docLevelPayment = docData.payment_method || null;
    const totalDiscount = docData.discount != null ? salesImporter.parseMoneyBr(docData.discount) : 0;
    const lineGross = (it) => salesImporter.parseMoneyBr(it.total ?? (salesImporter.parseMoneyBr(it.unit_price) * (it.quantity || 1)));
    const geminiItemsForDiscount = Array.isArray(docData.items) && docData.items.length ? docData.items : userItems;
    const itemGrossSumFull = geminiItemsForDiscount.reduce((s, it) => s + lineGross(it), 0);
    const allocDiscount = (gross) => {
      if (!totalDiscount || !itemGrossSumFull || !gross) return 0;
      return Math.round(totalDiscount * (gross / itemGrossSumFull) * 100) / 100;
    };

    const baseLaunchItems = userItems.map((it, idx) => ({
      ...it,
      ncm: it.ncm ?? docData.items?.[idx]?.ncm ?? null,
    }));
    let launchLineItems = baseLaunchItems;
    try {
      const enriched = await enrichGeminiDocItemsWithNcmReference({ items: baseLaunchItems });
      launchLineItems = Array.isArray(enriched?.items) ? enriched.items : baseLaunchItems;
    } catch (ncmErr) {
      logger.warn('launch-items: enriquecimento NCM ignorado:', ncmErr.message);
    }

    const payables = [];
    for (const item of launchLineItems) {
      let itemCategoryId = resolvedCategoryId;
      const explicitCat = categoryIdIfAllowed(item.catId, companyCats)
        || categoryIdIfAllowed(item.categoryId, companyCats)
        || categoryIdIfAllowed(item.category_id, companyCats);
      if (explicitCat) {
        itemCategoryId = explicitCat;
      } else {
        if (item.ncm_category_reference) {
          const mid = matchCompanyCategoryId(companyCats, String(item.ncm_category_reference), matchOptsLaunch);
          if (mid) itemCategoryId = mid;
        }
        const catName = item.category || item.catName;
        if (!itemCategoryId && catName) {
          const mid = matchCompanyCategoryId(companyCats, String(catName), matchOptsLaunch);
          if (mid) itemCategoryId = mid;
        }
        if (!itemCategoryId && (item.description || item.desc)) {
          const lineCtx = [
            docData.supplier_name,
            item.description || item.desc,
            item.ncm ? `NCM ${String(item.ncm).replace(/\D/g, '')}` : null,
            item.ncm_category_reference,
            catName,
          ]
            .filter((x) => x != null && String(x).trim() !== '')
            .join(' | ');
          const mid = matchCompanyCategoryId(companyCats, lineCtx, matchOptsLaunch);
          if (mid) itemCategoryId = mid;
        }
        if (!itemCategoryId && docData.suggested_category != null && docData.suggested_category !== '') {
          const lineCtxSug = [
            docData.supplier_name,
            item.description || item.desc,
            item.ncm ? `NCM ${String(item.ncm).replace(/\D/g, '')}` : null,
            item.ncm_category_reference,
            catName,
          ]
            .filter((x) => x != null && String(x).trim() !== '')
            .join(' | ');
          const mid = matchCompanyCategoryId(companyCats, String(docData.suggested_category), matchOptsLaunch);
          if (
            mid
            && !(categoryIdIsComprasOuFreteGenerico(companyCats, mid) && labelLooksLikeRetailStockLine(lineCtxSug))
          ) {
            itemCategoryId = mid;
          }
        }
      }

      const itemGross = lineGross(item);
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
          category_id:      payableCategoryIdOrFallback(itemCategoryId, companyCats),
          description:      (docType + ' — ' + supplier + ' | ' + desc).slice(0, 300),
          amount:           itemNet,
          due_date:         due,
          origin:           'document',
          origin_id:        documentId,
          status:           'open',
          created_by:       req.user.id,
          supplier_name:    supplier,
          item_description: desc.slice(0, 300),
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

    for (const d of docRows || []) {
      if (!d.file_url) continue;
      try {
        const signed = await signRocketDocUrl(d.file_url);
        if (signed) d.file_url = signed;
      } catch (e) {
        logger.warn('GET documents: assinatura de file_url ignorada', d.id, e.message);
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

    const { data: confirmCatsRaw } = await supabase
      .from('categories')
      .select('id,name,type,company_id')
      .or(`company_id.eq.${req.companyId},company_id.is.null`)
      .eq('active', true);
    const confirmCats = confirmCatsRaw || [];
    const safeCat = categoryIdIfAllowed(categoryId, confirmCats) || categoryIdIfAllowed(doc.category_id, confirmCats);

    // Cria conta a pagar
    const { data: payable } = await supabase
      .from('payables')
      .insert({
        company_id:  req.companyId,
        category_id: safeCat,
        description: `${(doc.doc_type||'DOC').toUpperCase()} — ${doc.supplier_name || doc.file_name}`,
        amount:      confirmedValue || doc.detected_value,
        due_date:    dueDateForPayable(confirmedDate, doc.gemini_data || {}, doc.detected_date),
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

// PATCH /api/documents/:companyId/:documentId/payables/:payableId/category
// Altera só a categoria de um título gerado pelo documento (permissão docs).
router.patch('/:companyId/:documentId/payables/:payableId/category',
  authenticate, requireCompanyAccess, requirePermission('docs'),
  async (req, res) => {
    const { documentId, payableId } = req.params;
    const { categoryId } = req.body;

    const { data: p, error: pe } = await supabase
      .from('payables')
      .select('id, origin, origin_id, status')
      .eq('id', payableId)
      .eq('company_id', req.companyId)
      .maybeSingle();
    if (pe || !p) return res.status(404).json({ error: 'Título não encontrado' });
    if (p.origin !== 'document' || String(p.origin_id) !== String(documentId)) {
      return res.status(400).json({ error: 'Este título não pertence ao documento indicado.' });
    }
    if (p.status === 'paid') {
      return res.status(400).json({ error: 'Título pago: altere a categoria em Contas a Pagar se necessário.' });
    }

    const { data: clsCats } = await supabase
      .from('categories')
      .select('id')
      .or(`company_id.eq.${req.companyId},company_id.is.null`)
      .eq('active', true);
    const safe = categoryIdIfAllowed(categoryId, clsCats || []);

    const { error } = await supabase
      .from('payables')
      .update({ category_id: safe })
      .eq('id', payableId)
      .eq('company_id', req.companyId);
    if (error) return res.status(400).json({ error: error.message });

    await supabase.from('access_logs').insert({
      user_id: req.user.id,
      company_id: req.companyId,
      action: `Categoria do título ${payableId} (documento ${documentId}) ajustada`,
      module: 'docs',
      details: { payableId, documentId, category_id: safe },
    });

    res.json({ message: 'Categoria atualizada', category_id: safe });
  },
);

// PATCH /api/documents/:companyId/:documentId/gemini-items
// Atualiza category_id / rótulo nos itens do JSON (documento ainda pendente).
router.patch('/:companyId/:documentId/gemini-items',
  authenticate, requireCompanyAccess, requirePermission('docs'),
  async (req, res) => {
    const { documentId } = req.params;
    const { items } = req.body;
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'Informe items: array de { index, category_id }' });
    }

    const { data: doc, error: dErr } = await supabase
      .from('client_documents')
      .select('id, gemini_data, status, payable_id')
      .eq('id', documentId)
      .eq('company_id', req.companyId)
      .single();
    if (dErr || !doc) return res.status(404).json({ error: 'Documento não encontrado' });
    const st = String(doc.status || '').toLowerCase();
    if (doc.payable_id || ['posted', 'auto_posted', 'lancado'].includes(st)) {
      return res.status(400).json({ error: 'Documento já lançado — edite a categoria em cada título (expandir itens).' });
    }

    const { data: catRows } = await supabase
      .from('categories')
      .select('id, name')
      .or(`company_id.eq.${req.companyId},company_id.is.null`)
      .eq('active', true);
    const catList = catRows || [];

    const gem = doc.gemini_data && typeof doc.gemini_data === 'object' ? { ...doc.gemini_data } : {};
    const arr = Array.isArray(gem.items) ? [...gem.items] : [];

    for (const row of items) {
      const idx = Number(row.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= arr.length) continue;
      const allowedCat = categoryIdIfAllowed(row.category_id, catList);
      const catRow = allowedCat ? catList.find((c) => String(c.id) === String(allowedCat)) : null;
      const next = { ...arr[idx] };
      if (allowedCat) {
        next.category_id = allowedCat;
        if (catRow?.name) next.category = catRow.name;
      }
      arr[idx] = next;
    }
    gem.items = arr;

    const { error } = await supabase
      .from('client_documents')
      .update({ gemini_data: jsonSafeForPostgres(gem) })
      .eq('id', documentId)
      .eq('company_id', req.companyId);
    if (error) return res.status(400).json({ error: error.message });

    res.json({ message: 'Itens atualizados', gemini_data: gem });
  },
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
