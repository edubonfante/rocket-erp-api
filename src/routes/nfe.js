const router  = require('express').Router();
const axios   = require('axios');
const xml2js  = require('xml2js');
const supabase = require('../db');
const { authenticate, requireCompanyAccess, requirePermission } = require('../middlewares/auth');
const logger = require('../utils/logger');

const espio = axios.create({ baseURL: process.env.ESPIO_BASE_URL });

// GET /api/nfe/:companyId — lista NF-es da empresa
router.get('/:companyId',
  authenticate,
  requireCompanyAccess,
  requirePermission('nfe'),
  async (req, res) => {
    const { status, dateFrom, dateTo, limit = 50, offset = 0 } = req.query;

    let query = supabase
      .from('nfe_entries')
      .select('*', { count: 'exact' })
      .eq('company_id', req.companyId)
      .order('issue_date', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (status)   query = query.eq('status', status);
    if (dateFrom) query = query.gte('issue_date', dateFrom);
    if (dateTo)   query = query.lte('issue_date', dateTo);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ data, total: count });
  }
);

// POST /api/nfe/:companyId/fetch — busca NF-es no Espião Cloud
router.post('/:companyId/fetch',
  authenticate,
  requireCompanyAccess,
  requirePermission('nfe'),
  async (req, res) => {
    const { cnpj, dateFrom, dateTo, modelo = '55' } = req.body;

    // Busca tokens da empresa
    const { data: company } = await supabase
      .from('companies')
      .select('espio_cnpj_token, cnpj')
      .eq('id', req.companyId)
      .single();

    if (!company?.espio_cnpj_token)
      return res.status(400).json({ error: 'Token do Espião não configurado para esta empresa' });

    try {
      const { data: espioData } = await espio.get('/v1-cloud/consulta/periodo/nfe-resumo', {
        headers: {
          'esp-cloud-token': company.espio_cnpj_token,
          'user-token': req.headers['x-espio-user-token'] || '',
        },
        params: {
          cnpjCpf: cnpj || company.cnpj.replace(/\D/g, ''),
          dataInicial: dateFrom,
          dataFinal: dateTo,
          modelo,
        }
      });

      // Salva/atualiza no banco
      const nfes = espioData?.data || [];
      let imported = 0;

      for (const nfe of nfes) {
        const { error } = await supabase.from('nfe_entries').upsert({
          company_id:    req.companyId,
          access_key:    nfe.chaveAcesso,
          supplier_name: nfe.emitente?.nome,
          supplier_cnpj: nfe.emitente?.cnpj,
          issue_date:    nfe.dataEmissao,
          total_value:   nfe.valorTotal,
          status:        'pending',
          imported_by:   req.user.id,
          xml_data:      nfe,
        }, { onConflict: 'access_key', ignoreDuplicates: true });

        if (!error) imported++;
      }

      logger.info(`NF-e fetch: ${imported} importadas p/ empresa ${req.companyId}`);
      res.json({ fetched: nfes.length, imported, data: nfes });

    } catch (err) {
      logger.error('Espião API error:', err.message);
      res.status(502).json({ error: 'Erro ao consultar Espião Cloud', detail: err.message });
    }
  }
);

// POST /api/nfe/:companyId/post — lança NF-e como conta a pagar
router.post('/:companyId/post',
  authenticate,
  requireCompanyAccess,
  requirePermission('nfe'),
  async (req, res) => {
    const { nfeIds, categoryId, bankAccount, costCenter, dueDate } = req.body;

    if (!nfeIds?.length)
      return res.status(400).json({ error: 'Selecione ao menos uma NF-e' });

    const { data: nfes } = await supabase
      .from('nfe_entries')
      .select('*')
      .in('id', nfeIds)
      .eq('company_id', req.companyId)
      .eq('status', 'pending');

    if (!nfes?.length)
      return res.status(404).json({ error: 'NF-es não encontradas ou já lançadas' });

    const payables = [];

    for (const nfe of nfes) {
      // Cria ou busca fornecedor
      let supplierId = null;
      if (nfe.supplier_cnpj) {
        const { data: existing } = await supabase
          .from('suppliers')
          .select('id')
          .eq('company_id', req.companyId)
          .eq('cnpj_cpf', nfe.supplier_cnpj)
          .single();

        if (existing) {
          supplierId = existing.id;
        } else {
          const { data: newSupp } = await supabase
            .from('suppliers')
            .insert({ company_id: req.companyId, name: nfe.supplier_name, cnpj_cpf: nfe.supplier_cnpj })
            .select('id').single();
          supplierId = newSupp?.id;
        }
      }

      // Cria conta a pagar
      const { data: payable } = await supabase
        .from('payables')
        .insert({
          company_id:   req.companyId,
          supplier_id:  supplierId,
          category_id:  categoryId,
          description:  `NF-e ${nfe.access_key?.slice(-6)} — ${nfe.supplier_name}`,
          amount:       nfe.total_value,
          due_date:     dueDate || new Date(Date.now() + 30*24*60*60*1000).toISOString().split('T')[0],
          bank_account: bankAccount,
          cost_center:  costCenter,
          origin:       'nfe',
          origin_id:    nfe.id,
          status:       'open',
          created_by:   req.user.id,
        })
        .select('id').single();

      // Atualiza NF-e como lançada
      await supabase
        .from('nfe_entries')
        .update({ status: 'posted', payable_id: payable.id })
        .eq('id', nfe.id);

      payables.push(payable);
    }

    // Log
    await supabase.from('access_logs').insert({
      user_id: req.user.id, company_id: req.companyId,
      action: `Lançou ${payables.length} NF-e(s) como contas a pagar`,
      module: 'nfe', details: { nfeIds, payableIds: payables.map(p => p.id) },
    });

    res.json({ message: `${payables.length} NF-e(s) lançadas com sucesso`, payables });
  }
);

// POST /api/nfe/:companyId/upload-xml — importa XML manualmente
router.post('/:companyId/upload-xml',
  authenticate,
  requireCompanyAccess,
  requirePermission('nfe'),
  async (req, res) => {
    const { xmlContent } = req.body;
    if (!xmlContent) return res.status(400).json({ error: 'XML não fornecido' });

    try {
      const parsed = await xml2js.parseStringPromise(xmlContent, { explicitArray: false });
      const nfe = parsed?.nfeProc?.NFe?.infNFe || parsed?.NFe?.infNFe;
      if (!nfe) return res.status(400).json({ error: 'XML de NF-e inválido' });

      const emit = nfe.emit;
      const total = nfe.total?.ICMSTot;
      const accessKey = nfe['$']?.Id?.replace('NFe', '') || '';

      // Extrair itens e buscar categoria pelo NCM
      const dets = nfe.det ? (Array.isArray(nfe.det) ? nfe.det : [nfe.det]) : [];
      let suggestedCategory = null;
      let suggestedCategoryId = null;
      if (dets.length > 0) {
        const firstNCM = dets[0]?.prod?.NCM;
        suggestedCategory = await getCategoryByNCM(firstNCM);
        if (suggestedCategory) {
          const { data: catData } = await supabase
            .from('categories')
            .select('id')
            .ilike('name', '%' + suggestedCategory + '%')
            .limit(1);
          suggestedCategoryId = catData?.[0]?.id || null;
        }
      }

      const { data, error } = await supabase.from('nfe_entries').upsert({
        company_id:    req.companyId,
        access_key:    accessKey,
        supplier_name: emit?.xNome,
        supplier_cnpj: emit?.CNPJ,
        issue_date:    nfe.ide?.dhEmi?.split('T')[0],
        total_value:   parseFloat(total?.vNF || 0),
        tax_value:     parseFloat(total?.vTotTrib || 0),
        xml_data:      nfe,
        status:        'pending',
        imported_by:   req.user.id,
        category_id:   suggestedCategoryId,
      }, { onConflict: 'access_key' });

      if (error) return res.status(400).json({ error: error.message });
      res.json({ message: 'XML importado com sucesso', data });
    } catch (err) {
      res.status(400).json({ error: 'Erro ao processar XML: ' + err.message });
    }
  }
);


// Busca categoria pelo NCM do item
async function getCategoryByNCM(ncmCode) {
  if (!ncmCode) return null;
  const prefix = ncmCode.replace(/\D/g, '').slice(0, 4);
  const { data } = await supabase
    .from('ncm_categories')
    .select('category_name')
    .like('ncm_code', prefix + '%')
    .limit(1);
  return data?.[0]?.category_name || null;
}

module.exports = router;
