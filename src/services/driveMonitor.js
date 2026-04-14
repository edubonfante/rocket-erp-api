const { google } = require('googleapis');
const supabase   = require('../db');
const gemini     = require('./geminiReader');
const logger     = require('../utils/logger');

/**
 * Serviço de monitoramento do Google Drive.
 * Monitora pastas configuradas por empresa/cliente e processa
 * automaticamente novos arquivos enviados.
 */
class DriveMonitor {

  constructor() {
    // Auth com Service Account do Google Cloud
    this.auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}'),
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    this.drive = google.drive({ version: 'v3', auth: this.auth });
  }

  /**
   * Escaneia todas as pastas configuradas e processa arquivos novos.
   * Chamado pelo Cloud Scheduler a cada 15 minutos.
   */
  async scanAll() {
    const { data: companies } = await supabase
      .from('companies')
      .select('id, name, drive_folder_id, drive_last_scan')
      .not('drive_folder_id', 'is', null)
      .eq('active', true);

    for (const company of (companies || [])) {
      try {
        await this.scanCompany(company);
      } catch (err) {
        logger.error(`Drive scan error para empresa ${company.name}:`, err.message);
      }
    }
  }

  /**
   * Escaneia a pasta de uma empresa específica.
   */
  async scanCompany(company) {
    const lastScan = company.drive_last_scan || '2000-01-01T00:00:00Z';

    // Lista arquivos novos desde o último scan
    const { data } = await this.drive.files.list({
      q: `'${company.drive_folder_id}' in parents
          and trashed = false
          and modifiedTime > '${lastScan}'
          and (mimeType contains 'image/' or mimeType = 'application/pdf')`,
      fields: 'files(id, name, mimeType, size, createdTime, parents, owners)',
      orderBy: 'createdTime',
      pageSize: 50,
    });

    const files = data.files || [];
    logger.info(`Drive scan: ${files.length} arquivo(s) novos para ${company.name}`);

    for (const file of files) {
      await this.processFile(file, company);
    }

    // Atualiza timestamp do último scan
    await supabase
      .from('companies')
      .update({ drive_last_scan: new Date().toISOString() })
      .eq('id', company.id);

    return files.length;
  }

  /**
   * Baixa e processa um arquivo do Drive.
   */
  async processFile(file, company) {
    try {
      // Verifica se já foi processado
      const { data: existing } = await supabase
        .from('client_documents')
        .select('id')
        .eq('drive_file_id', file.id)
        .single();

      if (existing) {
        logger.debug(`Arquivo já processado: ${file.name}`);
        return;
      }

      logger.info(`Processando: ${file.name} (${company.name})`);

      // Baixa o arquivo
      const res = await this.drive.files.get(
        { fileId: file.id, alt: 'media' },
        { responseType: 'arraybuffer' }
      );
      const buffer = Buffer.from(res.data);

      // Faz upload para Cloud Storage / Supabase Storage
      const storagePath = `documents/${company.id}/${Date.now()}_${file.name}`;
      const { data: uploaded } = await supabase.storage
        .from('rocket-erp-docs')
        .upload(storagePath, buffer, { contentType: file.mimeType });

      const fileUrl = supabase.storage.from('rocket-erp-docs').getPublicUrl(storagePath).data.publicUrl;

      // Lê com Gemini
      const geminiResult = await gemini.readDocument(buffer, file.mimeType);

      const docData = geminiResult.success ? geminiResult.data : {};

      // Busca categoria correspondente
      let categoryId = null;
      if (docData.suggested_category) {
        const { data: cat } = await supabase
          .from('categories')
          .select('id')
          .eq('company_id', company.id)
          .ilike('name', `%${docData.suggested_category}%`)
          .single();
        categoryId = cat?.id;
      }

      // Insere documento no banco
      const { data: doc } = await supabase
        .from('client_documents')
        .insert({
          company_id:      company.id,
          drive_file_id:   file.id,
          file_url:        fileUrl,
          file_name:       file.name,
          doc_type:        docData.doc_type || 'outro',
          detected_value:  docData.total_value,
          detected_date:   docData.issue_date,
          supplier_name:   docData.supplier_name,
          supplier_cnpj:   docData.supplier_cnpj,
          category_id:     categoryId,
          gemini_data:     docData,
          confidence:      docData.confidence || 0,
          status:          'pending',
        })
        .select('id').single();

      // Se confiança alta (>0.85), cria lançamento automaticamente
      if (docData.confidence >= 0.85 && docData.total_value > 0) {
        await this.autoCreatePayable(doc.id, company.id, docData, categoryId);
      }

      logger.info(`Documento processado: ${file.name} | R$ ${docData.total_value} | confiança: ${docData.confidence}`);

    } catch (err) {
      logger.error(`Erro ao processar arquivo ${file.name}:`, err.message);
    }
  }

  /**
   * Cria conta a pagar automaticamente quando Gemini tem alta confiança.
   */
  async autoCreatePayable(docId, companyId, geminiData, categoryId) {
    try {
      const { data: payable } = await supabase
        .from('payables')
        .insert({
          company_id:  companyId,
          category_id: categoryId,
          description: `${geminiData.doc_type?.toUpperCase()} — ${geminiData.supplier_name || 'Fornecedor não identificado'}`,
          amount:      geminiData.total_value,
          due_date:    geminiData.due_date || geminiData.issue_date || new Date().toISOString().split('T')[0],
          origin:      'document',
          origin_id:   docId,
          status:      'open',
          notes:       `Lançamento automático via Gemini (confiança: ${Math.round(geminiData.confidence * 100)}%)`,
        })
        .select('id').single();

      // Vincula ao documento
      await supabase
        .from('client_documents')
        .update({ payable_id: payable.id, status: 'auto_posted' })
        .eq('id', docId);

      logger.info(`Lançamento automático criado: R$ ${geminiData.total_value}`);
    } catch (err) {
      logger.error('Erro ao criar lançamento automático:', err.message);
    }
  }
}

module.exports = new DriveMonitor();
