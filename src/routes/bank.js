const router  = require('express').Router();
const multer  = require('multer');
const xlsx    = require('xlsx');
const supabase = require('../db');
const gemini  = require('../services/geminiReader');
const importer = require('../services/salesImporter');
const { authenticate, requireCompanyAccess, requirePermission } = require('../middlewares/auth');
const logger = require('../utils/logger');
const { matchCompanyCategoryId } = require('../utils/categoryMatch');
const { bankCategoryHint } = require('../utils/bankCategoryHints');
const { categoryIdIfAllowed } = require('../utils/categoryIdSafe');
const { syncPayableFromBankEntry } = require('../utils/bankPayableSync');
const {
  coerceBankDate,
  pickGeminiBankDescription,
  buildBankAiText,
  formatCategoryLabelsForAi,
  mapGeminiExtratoPayloadToTransactions,
  toBankTransactions,
  estimateBankFileDataRows,
  bankImportCompletenessWarning,
} = require('../utils/bankImportHelpers');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

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
        const result = await gemini.readBankStatement(req.file.buffer, req.file.mimetype, req.file.originalname);
        if (!result.success) return res.status(422).json({ error: result.error });
        transactions = (result.data.transactions || []).map((t) => {
          const raw = parseFloat(t.amount);
          const amount = Number.isFinite(raw) ? Math.round(raw * 100) / 100 : 0;
          const balRaw = t.balance != null ? parseFloat(t.balance) : null;
          const balance = balRaw != null && Number.isFinite(balRaw) ? Math.round(balRaw * 100) / 100 : null;
          const entryDate = coerceBankDate(t.date);
          let description = pickGeminiBankDescription(t);
          const compact = description.replace(/\s/g, '').replace(/[—\-]/g, '');
          if (compact.length < 2) {
            description = [entryDate, amount ? `${amount > 0 ? '+' : ''}${amount}` : null]
              .filter(Boolean)
              .join(' · ')
              .slice(0, 300) || 'Movimentação';
          }
          return {
            entry_date: entryDate,
            description,
            amount,
            balance,
            raw_data: {
              source: 'gemini_extrato',
              lancamento: t.lancamento != null ? String(t.lancamento).slice(0, 200) : null,
              favorecido: t.favorecido != null ? String(t.favorecido).slice(0, 300) : null,
              historico: t.historico != null ? String(t.historico).slice(0, 300) : null,
              doc_number: t.doc_number != null ? String(t.doc_number).slice(0, 80) : null,
            },
          };
        }).filter((t) => t.amount !== 0);
      } else {
        const rows = await importer.parse(req.file.buffer, req.file.originalname, req.file.mimetype);
        transactions = toBankTransactions(rows);
        if (!transactions.length && process.env.GEMINI_API_KEY) {
          let snippet = '';
          if (['csv', 'txt'].includes(ext)) {
            snippet = req.file.buffer.toString('utf-8').replace(/^\uFEFF/, '').slice(0, 70000);
          } else if (['xlsx', 'xls'].includes(ext)) {
            try {
              const wb = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: true });
              const names = wb.SheetNames || [];
              const chunks = [];
              for (const n of names.slice(0, 20)) {
                const sh = wb.Sheets[n];
                if (!sh) continue;
                importer.expandWorksheetRange(sh);
                const csv = xlsx.utils.sheet_to_csv(sh);
                chunks.push(`### Aba "${String(n).replace(/"/g, '')}"\n${csv.slice(0, 14000)}`);
                if (chunks.join('\n\n').length >= 68000) break;
              }
              snippet = chunks.join('\n\n').slice(0, 70000);
            } catch (e) {
              logger.warn('Bank import: leitura XLSX para Gemini:', e.message);
            }
          }
          if (snippet.replace(/\s/g, '').length > 30) {
            try {
              const g = await gemini.readBankCsvSnippet(req.file.originalname, snippet);
              if (g.success && g.data) {
                transactions = mapGeminiExtratoPayloadToTransactions(g.data);
              }
            } catch (e) {
              logger.warn('Bank import Gemini CSV:', e.message);
            }
          }
        }
      }

      if (!transactions.length) {
        return res.status(400).json({
          error:
            'Nenhuma linha válida no extrato. Confira data/valor no arquivo; com GEMINI_API_KEY o servidor tenta ler CSV/XLSX por IA quando o layout não é padrão. OFX ou PDF/imagem do extrato também funcionam.',
        });
      }

      const estimatedRows = estimateBankFileDataRows(req.file.buffer, ext);
      const completenessWarning = bankImportCompletenessWarning(estimatedRows, transactions.length);

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

      const stmtId = stmt.id;

      const { data: cats } = await supabase.from('categories')
        .select('id,name,type,account_code,company_id')
        .or(`company_id.eq.${req.companyId},company_id.is.null`)
        .eq('active', true);
      const catList = cats || [];
      const catNamesForAi = formatCategoryLabelsForAi(catList);
      const preferTypes = (amt) => (amt < 0 ? ['despesa', 'ambos'] : ['receita', 'ambos']);

      /** Gemini pode devolver "código — nome"; casamos também pelo nome do plano. */
      function matchGeminiLabelToCategoryId(catStr, pref) {
        const s = String(catStr || '').trim();
        if (!s) return null;
        let id = matchCompanyCategoryId(catList, s, { preferTypes: pref });
        if (id) return id;
        const tail = s.split(/\s*[—-]\s*/).pop().trim();
        if (tail && tail !== s) id = matchCompanyCategoryId(catList, tail, { preferTypes: pref });
        return id || null;
      }

      const inserted = [];
      try {
      for (let i = 0; i < transactions.length; i += 5) {
        const batch = transactions.slice(i, i + 5);
        await Promise.all(batch.map(async (t) => {
          const pref = preferTypes(t.amount);
          let catId = null;
          let aiSuggestion = null;

          const textForAi = buildBankAiText(t);
          const descTrim = String(t.description || '').trim();

          let suggestion = { category: null, confidence: 0, reason: '' };
          if (textForAi.length >= 4 && catNamesForAi.length && process.env.GEMINI_API_KEY) {
            try {
              suggestion = await gemini.suggestCategory(textForAi, t.amount, catNamesForAi);
            } catch (e) {
              logger.warn('suggestCategory skipped:', e.message);
            }
            const conf = Number(suggestion.confidence) || 0;
            const rawCat = suggestion.category;
            const catStr = rawCat != null && String(rawCat).trim().toLowerCase() !== 'null' ? String(rawCat).trim() : '';
            if (catStr && conf >= 0.48) {
              aiSuggestion = catStr;
              const matched = matchGeminiLabelToCategoryId(catStr, pref);
              if (matched) catId = matched;
            } else if (catStr && conf >= 0.2) {
              aiSuggestion = `${catStr} (~${Math.round(conf * 100)}%)`;
            } else if (String(suggestion.reason || '').trim()) {
              aiSuggestion = String(suggestion.reason).trim().slice(0, 200);
            }
          }

          /* Heurísticas locais só se a IA não definiu categoria (evita “tudo compras” por regra genérica). */
          if (!catId && descTrim.length >= 4) {
            const ruleHint = bankCategoryHint(t.description, t.amount);
            if (ruleHint) {
              const matchedRule = matchCompanyCategoryId(catList, ruleHint, { preferTypes: pref });
              if (matchedRule) {
                catId = matchedRule;
                if (!aiSuggestion) aiSuggestion = ruleHint;
              }
            }
          }

          /* Mantém "pending" na lista padrão mesmo com categoria sugerida — evita "sumir" da aba Pendentes. */
          const safeCatId = categoryIdIfAllowed(catId, catList);
          const aiSafe = aiSuggestion != null ? String(aiSuggestion).trim().slice(0, 200) : null;
          const baseRow = {
            company_id: req.companyId,
            statement_id: stmtId,
            entry_date: coerceBankDate(t.entry_date),
            description: (t.description || '—').toString().slice(0, 300),
            amount: Number.isFinite(t.amount) ? t.amount : 0,
            balance: t.balance,
            category_id: safeCatId,
            ai_suggestion: aiSafe || null,
            status: 'pending',
          };
          const rawSnap = t.raw_data && typeof t.raw_data === 'object' ? t.raw_data : null;
          let row = rawSnap ? { ...baseRow, raw_data: rawSnap } : { ...baseRow };
          let { data: entry, error: entErr } = await supabase.from('bank_entries').insert(row).select('id').single();

          /* PostgREST às vezes ainda não vê raw_data (cache) ou coluna ausente no projeto — importa sem JSON extra. */
          if (entErr && rawSnap && /raw_data|schema cache|PGRST204|column/i.test(String(entErr.message || ''))) {
            logger.warn('bank_entries: importando sem raw_data (retry):', entErr.message);
            ({ data: entry, error: entErr } = await supabase.from('bank_entries').insert({ ...baseRow }).select('id').single());
          }

          if (entErr) {
            logger.error('bank_entries insert:', entErr.message);
            throw new Error(entErr.message);
          }
          if (entry) inserted.push(entry.id);
        }));
      }
      } catch (innerErr) {
        await supabase.from('bank_statements').delete().eq('id', stmtId).eq('company_id', req.companyId);
        throw innerErr;
      }

      res.json({
        message: `${inserted.length} lançamentos importados`,
        statementId: stmtId,
        total: inserted.length,
        estimatedRows: estimatedRows ?? undefined,
        warning: completenessWarning || undefined,
      });
    } catch (err) {
      logger.error('Bank import error:', err);
      res.status(500).json({ error: err.message || 'Erro ao importar extrato' });
    }
  }
);

// GET /api/bank/:companyId/statements — extratos importados (para remover import incompleto)
router.get('/:companyId/statements',
  authenticate, requireCompanyAccess, requirePermission('conciliacao'),
  async (req, res) => {
    const { data: stmts, error } = await supabase
      .from('bank_statements')
      .select('id, filename, bank_account, period_start, period_end, created_at')
      .eq('company_id', req.companyId)
      .order('created_at', { ascending: false })
      .limit(40);
    if (error) return res.status(500).json({ error: error.message });
    const list = stmts || [];
    const withCounts = await Promise.all(
      list.map(async (s) => {
        const { count, error: cErr } = await supabase
          .from('bank_entries')
          .select('id', { count: 'exact', head: true })
          .eq('statement_id', s.id);
        if (cErr) return { ...s, entry_count: 0 };
        return { ...s, entry_count: count ?? 0 };
      }),
    );
    res.json({ data: withCounts });
  },
);

// DELETE /api/bank/:companyId/statements/:statementId — remove extrato e todos os lançamentos (CASCADE)
router.delete('/:companyId/statements/:statementId',
  authenticate, requireCompanyAccess, requirePermission('conciliacao'),
  async (req, res) => {
    const sid = String(req.params.statementId || '').trim();
    if (!sid) return res.status(400).json({ error: 'statementId inválido' });
    const { error } = await supabase
      .from('bank_statements')
      .delete()
      .eq('id', sid)
      .eq('company_id', req.companyId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: 'Extrato e lançamentos associados foram removidos.' });
  },
);

// GET /api/bank/:companyId/entries — lista lançamentos (pendentes, classificados ou todos)
router.get('/:companyId/entries',
  authenticate, requireCompanyAccess, requirePermission('conciliacao'),
  async (req, res) => {
    const { status, statementId } = req.query;
    let q = supabase.from('bank_entries')
      .select('*, categories(id,name,color)')
      .eq('company_id', req.companyId)
      .order('entry_date', { ascending: false })
      .limit(Math.min(Math.max(parseInt(req.query.limit, 10) || 8000, 1), 20000));

    if (status && String(status).toLowerCase() !== 'all') {
      q = q.eq('status', status);
    }
    if (statementId) q = q.eq('statement_id', statementId);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ data });
  }
);

// PATCH /api/bank/:companyId/entries/bulk-classify — classifica vários pendentes de uma vez
router.patch('/:companyId/entries/bulk-classify',
  authenticate, requireCompanyAccess, requirePermission('conciliacao'),
  async (req, res) => {
    const rawIds = Array.isArray(req.body.ids) ? req.body.ids : [];
    const ids = [...new Set(rawIds.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 500);
    const { categoryId, status = 'classified' } = req.body;
    if (!ids.length) return res.status(400).json({ error: 'Informe ao menos um lançamento (ids).' });

    const { data: clsCats } = await supabase.from('categories')
      .select('id')
      .or(`company_id.eq.${req.companyId},company_id.is.null`)
      .eq('active', true);
    const safeCat = categoryIdIfAllowed(categoryId, clsCats || []);

    const { data: updated, error } = await supabase
      .from('bank_entries')
      .update({ category_id: safeCat, status })
      .eq('company_id', req.companyId)
      .in('status', ['pending', 'classified'])
      .in('id', ids)
      .select('id');

    if (error) return res.status(400).json({ error: error.message });
    const n = (updated || []).length;
    const updatedIds = (updated || []).map((r) => r.id).filter(Boolean);
    for (const eid of updatedIds) {
      await syncPayableFromBankEntry(supabase, { companyId: req.companyId, userId: req.user.id, entryId: eid });
    }
    res.json({
      message: n
        ? `${n} lançamento(s) classificado(s)`
        : 'Nenhum lançamento pendente foi atualizado (confira os itens selecionados).',
      count: n,
    });
  }
);

// PATCH /api/bank/:companyId/entries/:id/classify — classifica entrada
router.patch('/:companyId/entries/:id/classify',
  authenticate, requireCompanyAccess, requirePermission('conciliacao'),
  async (req, res) => {
    const { categoryId, status = 'classified' } = req.body;
    const hasPayableField = Object.prototype.hasOwnProperty.call(req.body, 'payableId');
    const payableId = req.body.payableId;

    const { data: clsCats } = await supabase.from('categories')
      .select('id')
      .or(`company_id.eq.${req.companyId},company_id.is.null`)
      .eq('active', true);
    const safeCat = categoryIdIfAllowed(categoryId, clsCats || []);

    const patch = { category_id: safeCat, status };
    if (hasPayableField) patch.payable_id = payableId || null;

    const { error } = await supabase.from('bank_entries')
      .update(patch)
      .eq('id', req.params.id).eq('company_id', req.companyId);

    if (error) return res.status(400).json({ error: error.message });

    await syncPayableFromBankEntry(supabase, {
      companyId: req.companyId,
      userId: req.user.id,
      entryId: req.params.id,
    });

    res.json({ message: 'Classificado' });
  }
);

/** Volta lançamento para pendente (remove categoria) — não usar se já conciliado com contas a pagar. */
router.patch('/:companyId/entries/:id/revert',
  authenticate, requireCompanyAccess, requirePermission('conciliacao'),
  async (req, res) => {
    const { id } = req.params;
    const { data: row, error: fErr } = await supabase
      .from('bank_entries')
      .select('id,status,payable_id')
      .eq('id', id)
      .eq('company_id', req.companyId)
      .maybeSingle();
    if (fErr || !row) return res.status(404).json({ error: 'Lançamento não encontrado' });
    if (row.status === 'matched') {
      return res.status(400).json({
        error:
          'Este lançamento está vinculado a contas a pagar. Remova o vínculo em Contas a Pagar antes de estornar.',
      });
    }
    if (row.status === 'ignored') {
      return res.status(400).json({ error: 'Lançamento ignorado não pode ser estornado por aqui.' });
    }
    if (row.payable_id) {
      const { data: pay, error: pErr } = await supabase
        .from('payables')
        .select('id,status')
        .eq('id', row.payable_id)
        .eq('company_id', req.companyId)
        .maybeSingle();
      if (pErr) return res.status(500).json({ error: pErr.message });
      if (pay?.status === 'paid') {
        return res.status(400).json({
          error: 'O título vinculado já está pago. Ajuste em Contas a Pagar antes de estornar o extrato.',
        });
      }
      await supabase
        .from('payables')
        .update({ status: 'cancelled' })
        .eq('id', row.payable_id)
        .eq('company_id', req.companyId);
    }
    const { error } = await supabase
      .from('bank_entries')
      .update({
        status: 'pending',
        category_id: null,
        payable_id: null,
      })
      .eq('id', id)
      .eq('company_id', req.companyId);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ message: 'Lançamento voltou para pendentes.' });
  },
);

module.exports = router;
