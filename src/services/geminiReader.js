const {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
} = require('@google/generative-ai');
const logger = require('../utils/logger');

/** Remove espaços acidentais, BOM e aspas externas (copiar/colar do .env ou Railway). */
function normalizeGeminiApiKey(raw) {
  if (raw == null) return '';
  let k = String(raw).trim().replace(/^\uFEFF/, '');
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1).trim();
  }
  return k;
}

/**
 * Mensagem legível para o app (evita só "Erro ao analisar a imagem" sem contexto).
 * Caso comum: chave exposta em log/repositório → Google revoga com 403 "leaked".
 */
function formatGeminiApiError(raw) {
  const m = String(raw || '');
  if (/leaked|API key was reported as leaked/i.test(m)) {
    return 'A chave da API do Gemini foi revogada (Google detectou possível vazamento). Crie outra em https://aistudio.google.com/apikey e defina GEMINI_API_KEY no Railway (Variables) ou no backend/.env; depois npm run railway:vars e redeploy.';
  }
  if (/\[403 Forbidden\]|403 Forbidden|API key not valid|API_KEY_INVALID|permission denied/i.test(m)) {
    return 'Chave da API do Gemini inválida ou sem permissão. Use uma chave criada em https://aistudio.google.com/apikey (Google AI / Gemini), sem espaços no início ou fim, e atualize GEMINI_API_KEY no Railway ou no servidor.';
  }
  if (/404|not found/i.test(m) && /model/i.test(m)) {
    return 'Modelo Gemini não encontrado. Ajuste GEMINI_MODEL (ex.: gemini-2.5-flash ou gemini-2.0-flash).';
  }
  if (/429|RESOURCE_EXHAUSTED|quota|rate limit/i.test(m)) {
    return 'Limite de uso da API Gemini atingido. Tente mais tarde ou verifique o plano em Google AI Studio.';
  }
  return m.length > 600 ? `${m.slice(0, 597)}…` : m;
}

/** MIME que o browser ou SO enviam errado — o Gemini é estrito. */
function normalizeMimeType(mimeType, filename = '') {
  const raw = String(mimeType || '').toLowerCase().split(';')[0].trim();
  const name = String(filename || '').toLowerCase();
  if (raw === 'image/jpg' || raw === 'image/pjpeg') return 'image/jpeg';
  if (raw === 'application/octet-stream' || raw === '' || raw === 'binary/octet-stream') {
    if (name.endsWith('.png')) return 'image/png';
    if (name.endsWith('.webp')) return 'image/webp';
    if (name.endsWith('.heic')) return 'image/heic';
    if (name.endsWith('.heif')) return 'image/heif';
    if (name.endsWith('.pdf')) return 'application/pdf';
    if (/\.(jpe?g)$/.test(name)) return 'image/jpeg';
  }
  return raw || 'image/jpeg';
}

function extractJsonObjectString(raw) {
  let t = String(raw ?? '').trim();
  if (!t) return '';
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const i0 = t.indexOf('{');
  const i1 = t.lastIndexOf('}');
  if (i0 >= 0 && i1 > i0) return t.slice(i0, i1 + 1);
  return t;
}

function parseGeminiJson(text) {
  const slice = extractJsonObjectString(text);
  if (!slice) return null;
  try {
    return JSON.parse(slice);
  } catch {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
}

function docSafetySettings() {
  const t = HarmBlockThreshold.BLOCK_ONLY_HIGH;
  return [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: t },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: t },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: t },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: t },
    { category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY, threshold: t },
  ];
}

/** Injeta nomes reais do plano de contas para suggested_category bater com o ERP. */
function buildReadDocumentPrompt(expenseCategoryNames) {
  const names = Array.isArray(expenseCategoryNames)
    ? [...new Set(expenseCategoryNames.map((s) => String(s || '').trim()).filter(Boolean))]
    : [];
  const max = 600;
  const slice = names.slice(0, max);

  const planBlock =
    slice.length > 0
      ? `

PRIORIDADE PARA CONTABILIZAÇÃO — campos "suggested_category" (documento) e "category" (cada item em "items"):
REGRA DE OURO - ANTES DE TUDO:
- Qualquer item com "CHOC", "CHOCOLATE", "KIT KAT", "BIS ", "LACTA", "NESTLE CHOC", "CACAU", "NESCAU", "ACHOCOLATADO" no nome = SEMPRE "Sobremesa - Cafe". NUNCA Hortifruti.
- "Hortifruti" = SOMENTE frutas frescas, legumes frescos e verduras. Ex: tomate, cebola, alface, banana, laranja. NUNCA use para produtos industrializados.
- Produtos com prefixo "REFR." = refrigerante = "Bebidas - Agua, refrigerantes e sucos"
- "LIMP.", "ALCOOL", "DETERG", "SABAO", "DESINF", "MULTIUSO", "CLORO", "ALVEJ" = "Material de Higiene e Limpeza"
- "CANELA", "LIMAO PEPPER", "PIMENTA", "TEMPERO", "OREGANO", "COLORAU", "COMINHO", "MOSTARDA PO", "CURRY", "PAPRICA" = "Secos - Molhos e Temperos"
- "OLEO DE SOJA", "AZEITE", "VINAGRE", "BANHA" = "Secos - Oleos e Azeites"
- "FARINHA", "AMIDO", "FUBA", "POLVILHO", "MAIZENA" = "Secos - Farinaceos"
- "MARGARINA", "MANTEIGA" = "Laticinios - Derivados"
- Produtos com "ALC." ou "ALCOOL" no nome e produto de limpeza = "Material de Higiene e Limpeza"

0) NCM (Nota Fiscal, NFC-e, cupom SAT/CF-e, XML/DANFE em imagem): em CADA item de produto, leia e preencha "ncm" com os 4 a 8 dígitos do código NCM quando existir no documento (colunas "NCM", "Cód. fiscal", "Classif. fiscal", etc.). O NCM é a referência fiscal principal da mercadoria no Brasil — use a família do NCM (capítulo/posição, ex.: bebidas, laticínios, café/chá, carnes) como base PRINCIPAL para escolher "category" e para aproximar ao PLANO DA EMPRESA. Se o cupom listar NCM por linha, um NCM por item; não invente dígitos.
1) Quando houver correspondência clara, use EXATAMENTE um dos nomes do PLANO DA EMPRESA abaixo (cópia literal: acentos, hífens, maiúsculas).
2) Se nenhum nome do plano servir, use o nome mais especifico do PLANO DA EMPRESA ou null. NUNCA use "Hortifruti" para produtos industrializados, chocolates, biscoitos, embutidos.
3) Cada linha em "items" é produto/serviço de ESTOQUE ou operação — use CMV / mercadoria / hortifruti / bebidas etc. NÃO use categoria de imposto (PIS, COFINS, ICMS na nota) para linhas de mercadoria; imposto só se a linha for explicitamente taxa/tributo avulso.
4) Café, chá, achocolatado, sobremesa, chocolate e produtos com prefixo "CHOC." no nome: no PLANO DA EMPRESA use SEMPRE "Sobremesa - Cafe" (NCM cap.18: 1801-1806 = cacau e chocolate). Kit Kat, Bis, Serenata, Lacta, Nestlé chocolate = "Sobremesa - Cafe". NUNCA classifique chocolate como Hortifruti. NUNCA use "Compras e fretes" ou "Frete e transporte" para produto de nota fiscal.
5) Embutidos e charcutaria (salsicha, mortadela, presunto, salame, linguiça, bacon, peito de peru, fiambre, apresuntado, defumados): use "Frios e Embutidos" do plano — NUNCA classifique como "Secos" / "Alimentos secos" / mercearia genérica só por ser alimento.
6) Cupom fiscal / SAT-CF-e com poucas linhas ou uma linha: preencha "category" em CADA item com o tipo real do produto (não use "Outros", "Secos" ou "Compras e fretes" se o texto descrever embutido, frio, charque, etc.). "suggested_category" do documento deve refletir o que predomina nos itens (ex.: predominância de embutidos → nome "Frios e Embutidos" do PLANO ou o rótulo CMV "Frios e Embutidos").
7) "suggested_category" do documento NUNCA deve ser "Compras e fretes" / "Frete e transporte" quando os itens forem mercadoria de revenda (NCM/produto); nesse caso use o nome exato do PLANO (Frios e Embutidos, Bebidas, CMV, etc.) ou null.

PLANO DA EMPRESA (${slice.length} categorias):
${slice.map((n) => `- ${String(n).replace(/\s+/g, ' ').slice(0, 600)}`).join('\n')}
`
      : '';

  return `Você é um sistema especialista em contabilidade brasileira.
Analise este documento fiscal/financeiro e extraia TODOS os dados disponíveis.
Responda SOMENTE com um JSON válido, sem markdown, sem explicações.

Estrutura obrigatória do JSON:
{
  "doc_type": "nota_fiscal | cupom_fiscal | recibo | boleto | fatura | extrato | outro",
  "supplier_name": "nome do emitente/fornecedor ou null",
  "supplier_cnpj": "CNPJ formatado XX.XXX.XXX/XXXX-XX ou null",
  "supplier_cpf": "CPF se pessoa física ou null",
  "issue_date": "data de emissão YYYY-MM-DD ou null",
  "due_date": "data de vencimento YYYY-MM-DD ou null",
  "total_value": número decimal sem formatação (ex: 234.50) ou null,
  "subtotal": número decimal ou null,
  "discount": número decimal ou null,
  "tax_value": número decimal ou null,
  "payment_method": "pix | dinheiro | credito | debito | boleto | transferencia | outro | null",
  "installments": número de parcelas ou null,
  "document_number": "número da nota/cupom/recibo ou null",
  "access_key": "chave de acesso NF-e 44 dígitos ou null",
  "items": [
    {
      "description": "descrição do item",
      "ncm": "código NCM do item (4 a 8 dígitos, só números) ou null — obrigatório quando constar no cupom/NF",
      "quantity": número,
      "unit_price": número decimal,
      "total": número decimal,
      "category": "categoria do DRE para este item ou null"
    }
  ],
  "suggested_category": "categoria contábil geral do documento ou null",
  "confidence": número de 0 a 1 indicando confiança na leitura,
  "observations": "observações relevantes ou null",
  "raw_text": "texto completo extraído do documento"
}

Categorias CMV / NCM (use EXATAMENTE um destes rótulos no campo "category" quando o PLANO DA EMPRESA acima não tiver nome melhor — alinhado ao plano varejo Rocket):
- Proteínas - Aves
- Proteínas - Bovinos
- Proteínas - Peixe e Frutos do Mar
- Proteínas - Ovinos
- Proteínas - Suínos
- Proteínas - Veganos
- Sobremesa - Café
- Sobremesa - Sobremesa
- Laticínios - Queijos
- Laticínios - Derivados
- Secos - Óleos e Azeites
- Secos - Farináceos
- Secos - Molhos e Temperos
- Secos - Mercearia
- Embalagens e Descartáveis - Embalagens
- Embalagens e Descartáveis - Descartáveis
- Bebidas - Agua, refrigerantes e sucos
- Bebidas Alcoólicas - Cerveja
- Bebidas Alcoólicas - Destilados
- Bebidas Alcoólicas - Vinhos
- Gelo
- Frios e Embutidos (salsicha, presunto, salame, mortadela, linguiça, bacon, peito de peru, fiambre, apresuntado, defumados — NÃO use "Secos" para estes)
- Congelados
- Hortifruti
- Hortifruti Congelado
- Padaria
- Outros Custos Variáveis

IMPORTANTE: Álcool de limpeza / papel higiene / detergente = categoria de higiene do PLANO DA EMPRESA (não use esta lista CMV de alimento para limpeza).
${planBlock}
Seja preciso. Se não tiver certeza de um campo, use null.`;
}

function createGenerativeModel(apiKey) {
  const key = normalizeGeminiApiKey(apiKey);
  if (!key) return null;

  const genAI = new GoogleGenerativeAI(key);
  const modelName = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();

  /* Não usar responseMimeType aqui: com imagem/PDF (inlineData) a API costuma falhar (400) ou esvaziar a resposta. */
  const generationConfig = {
    temperature: 0.15,
    maxOutputTokens: 40960,
  };

  const timeoutMs = Math.max(30000, Number(process.env.GEMINI_TIMEOUT_MS) || 120000);

  return genAI.getGenerativeModel(
    {
      model: modelName,
      safetySettings: docSafetySettings(),
      generationConfig,
    },
    { timeout: timeoutMs }
  );
}

/** Só texto: JSON mode ajuda o parse; não misturar com inlineData. */
const textJsonGenerationConfig = {
  temperature: 0.15,
  maxOutputTokens: 40960,
  responseMimeType: 'application/json',
};

/**
 * Serviço de leitura inteligente de documentos via Gemini Vision.
 */
class GeminiDocReader {
  constructor() {
    this._model = null;
    this._modelKey = null;
  }

  getModel() {
    const key = normalizeGeminiApiKey(process.env.GEMINI_API_KEY);
    if (!key) return null;
    if (this._modelKey !== key) {
      this._modelKey = key;
      this._model = null;
    }
    if (!this._model) this._model = createGenerativeModel(key);
    return this._model;
  }

  /**
   * Analisa imagem de documento e retorna dados estruturados.
   * @param {object} [options] - expenseCategoryNames: string[] nomes de categorias despesa/ambos do ERP (plano de contas).
   */
  async readDocument(imageBuffer, mimeType = 'image/jpeg', filename = '', options = {}) {
    const mime = normalizeMimeType(mimeType, filename);
    const model = this.getModel();
    if (!model) {
      return {
        success: false,
        error: 'GEMINI_API_KEY não configurada no servidor (Railway → Variables, ou backend/.env).',
        data: null,
      };
    }

    const expenseNames = options?.expenseCategoryNames;
    const prompt = buildReadDocumentPrompt(expenseNames);

    try {
      const imagePart = {
        inlineData: {
          data: imageBuffer.toString('base64'),
          mimeType: mime,
        },
      };

      const result = await model.generateContent({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }, imagePart],
          },
        ],
      });
      let text;
      try {
        text = result.response.text().trim();
      } catch (e) {
        const msg = e?.message || String(e);
        logger.error(`Gemini readDocument (resposta bloqueada ou inválida): ${msg}`);
        return { success: false, error: formatGeminiApiError(msg), data: null };
      }

      if (!text) {
        return { success: false, error: 'Resposta vazia do modelo (tente outra foto ou formato JPEG/PNG).', data: null };
      }

      const data = parseGeminiJson(text);
      if (!data || typeof data !== 'object') {
        logger.warn(`Gemini readDocument: JSON não parseável — amostra: ${text.slice(0, 400)}`);
        return {
          success: false,
          error: 'O modelo não retornou JSON válido. Tente foto mais nítida ou outro ângulo.',
          data: null,
        };
      }

      logger.info(`Gemini leu documento: ${data.doc_type} | R$ ${data.total_value} | confiança: ${data.confidence}`);
      return { success: true, data };
    } catch (err) {
      const msg = err?.message || err?.cause?.message || String(err);
      logger.error(`Gemini readDocument error: ${msg}`);
      return { success: false, error: formatGeminiApiError(msg), data: null };
    }
  }

  /**
   * Analisa múltiplas páginas (ex: PDF multipágina convertido em imagens).
   */
  async readMultiPage(pages, options = {}) {
    const results = await Promise.all(
      pages.map((p) => this.readDocument(p.buffer, p.mimeType, p.filename || '', options))
    );
    const best = results
      .filter((r) => r.success)
      .sort((a, b) => (b.data.confidence || 0) - (a.data.confidence || 0))[0];
    return best || { success: false, error: 'Nenhuma página lida com sucesso' };
  }

  /**
   * Lê extrato bancário e retorna lista de transações estruturadas.
   */
  async readBankStatement(imageBuffer, mimeType = 'image/jpeg', filename = '') {
    const mime = normalizeMimeType(mimeType, filename);
    const model = this.getModel();
    if (!model) {
      return { success: false, error: 'GEMINI_API_KEY não configurada no servidor' };
    }

    const prompt = `Você é um sistema especialista em extratos bancários brasileiros.
Analise este extrato e extraia TODAS as transações visíveis.
Responda SOMENTE com JSON válido, sem markdown.

{
  "bank_name": "nome do banco ou null",
  "account": "número da conta ou null",
  "period_start": "YYYY-MM-DD ou null",
  "period_end": "YYYY-MM-DD ou null",
  "initial_balance": número ou null,
  "final_balance": número ou null,
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "description": "descrição da transação",
      "amount": número (positivo = crédito, negativo = débito),
      "balance": número após transação ou null,
      "doc_number": "número do documento ou null",
      "lancamento": "tipo de lançamento na linha (PIX, TED, DOC, boleto, tarifa, etc.) ou null",
      "favorecido": "nome do favorecido, estabelecimento ou razão social quando aparecer ou null",
      "historico": "histórico / complemento do banco ou null"
    }
  ]
}`;

    try {
      const imagePart = { inlineData: { data: imageBuffer.toString('base64'), mimeType: mime } };
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }, imagePart] }],
      });
      let text;
      try {
        text = result.response.text().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      } catch (e) {
        return { success: false, error: formatGeminiApiError(e?.message || String(e)) };
      }
      const data = parseGeminiJson(text);
      if (!data) return { success: false, error: 'JSON inválido na resposta do extrato' };
      return { success: true, data };
    } catch (err) {
      const msg = err?.message || err?.cause?.message || String(err);
      logger.error(`Gemini readBankStatement error: ${msg}`);
      return { success: false, error: formatGeminiApiError(msg) };
    }
  }

  /**
   * Extrato em CSV/TXT (exportação do internet banking): mesmo JSON que readBankStatement.
   */
  async readBankCsvSnippet(filename, textSnippet) {
    const model = this.getModel();
    if (!model) return { success: false, error: 'GEMINI_API_KEY não configurada', data: null };

    const snippet = String(textSnippet || '').slice(0, 70000);
    const prompt = `Você é um sistema especialista em extratos bancários brasileiros (OFX/CSV exportado pelo banco).
Arquivo: ${filename}

Abaixo pode haver VÁRIOS blocos "### Aba …" (várias folhas do Excel) ou um único CSV. Cabeçalho + linhas; separador vírgula, ponto-e-vírgula ou TAB.
Extraia TODAS as movimentações de TODAS as abas/blocos (ignore só saldo inicial/final isolado, cabeçalhos duplicados e linhas em branco).

Trecho:
${snippet}

Responda SOMENTE com JSON válido, sem markdown, mesma estrutura que para imagem de extrato:
{
  "bank_name": null,
  "account": null,
  "period_start": "YYYY-MM-DD ou null",
  "period_end": "YYYY-MM-DD ou null",
  "initial_balance": null,
  "final_balance": null,
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "description": "texto útil (histórico + favorecido quando houver)",
      "amount": número (positivo = crédito/entrada, negativo = débito/saída),
      "balance": null,
      "doc_number": null,
      "lancamento": null,
      "favorecido": null,
      "historico": null
    }
  ]
}

Regras:
- amount: use sinal negativo para débito, positivo para crédito; se o CSV tiver colunas "Crédito" e "Débito" separadas, use o valor não nulo da linha com o sinal correto.
- date: DD/MM/AAAA → converta para YYYY-MM-DD.
- Se não houver transações: {"transactions":[]}.`;

    try {
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: textJsonGenerationConfig,
      });
      let text;
      try {
        text = result.response.text().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      } catch (e) {
        return { success: false, error: formatGeminiApiError(e?.message || String(e)), data: null };
      }
      const data = parseGeminiJson(text);
      if (!data || !Array.isArray(data.transactions)) {
        return { success: false, error: 'Resposta sem array transactions', data: null };
      }
      return { success: true, data };
    } catch (err) {
      const msg = err?.message || err?.cause?.message || String(err);
      logger.error(`Gemini readBankCsvSnippet error: ${msg}`);
      return { success: false, error: formatGeminiApiError(msg), data: null };
    }
  }

  /**
   * Interpreta trecho de planilha/CSV de vendas e devolve linhas normalizadas.
   */
  async readSalesSnippet(filename, sheetLabel, textSnippet) {
    const model = this.getModel();
    if (!model) return { success: false, error: 'GEMINI_API_KEY não configurada', data: null };

    const snippet = String(textSnippet || '').slice(0, 70000);
    const prompt = `Você interpreta exportações de vendas de PDV/ERP brasileiros.
Arquivo: ${filename}
Planilha/bloco: ${sheetLabel}

Trecho (cabeçalho + linhas; pode ser TAB ou vírgula):
${snippet}

Tarefa: identificar cada LINHA DE VENDA individual (ignore linhas só de total, subtotal, taxa, cabeçalho repetido).
Responda SOMENTE com JSON válido, sem markdown:
{"sales":[{"sale_date":"YYYY-MM-DD","gross_value":0,"discount":0,"net_value":0,"payment_method":"pix|dinheiro|credito|debito|boleto|transferencia|voucher|cupom|outros|null","quantity":1,"cancelled":false,"revenue_category":null}]}

Campo opcional revenue_category: use EXATAMENTE um destes nomes (receita do plano) quando a evidência na linha for clara; senão null:
Receita comercial - Dinheiro | Cheque | Cartão de crédito | Cartão de débito | À vista | Boletos | PIX | Transferência | Elo | Mastercard | Visa | Hipercard | Alelo | Ben | Sodexo | Ticket | VR | iFood | Rappi | Uber Eats
| Rendimentos de aplicações | Outras receitas financeiras

Regras:
- Valores são números decimais sem "R$" ou texto.
- Se só existir um valor por linha, coloque em net_value e gross_value igual.
- payment_method: use EXATAMENTE um destes: pix|dinheiro|credito|debito|boleto|transferencia|voucher|cupom|outros|null
  • Colunas como PIX, TED, DOC, transferência → transferencia ou pix conforme o texto.
  • Dinheiro, espécie, caixa → dinheiro.
  • Cartão, Visa, Master, Elo, Cielo, Rede, parcelado, crédito, débito POS → credito ou debito conforme o texto.
  • Vale-refeição, Alelo, Sodexo, Ticket, VR, iFood voucher → voucher.
  • Boleto, código de barras → boleto.
  • NFC-e, SAT, cupom fiscal sem meio claro → cupom.
  • Leia o cabeçalho das colunas para inferir o meio quando a célula estiver vaga.
- cancelled true se a linha indicar cancelamento/estorno.
- Se não houver vendas: {"sales":[]}.`;

    try {
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: textJsonGenerationConfig,
      });
      let text;
      try {
        text = result.response.text().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      } catch (e) {
        return { success: false, error: formatGeminiApiError(e?.message || String(e)), data: null };
      }
      const data = parseGeminiJson(text);
      if (!data || !Array.isArray(data.sales)) {
        return { success: false, error: 'Resposta sem array sales', data: null };
      }
      return { success: true, data };
    } catch (err) {
      const msg = err?.message || err?.cause?.message || String(err);
      logger.error(`Gemini readSalesSnippet error: ${msg}`);
      return { success: false, error: formatGeminiApiError(msg), data: null };
    }
  }

  /**
   * Várias abas de Excel: envia trechos rotulados e recebe um único array `sales`.
   */
  async readSalesWorkbook(filename, sheetParts) {
    const model = this.getModel();
    if (!model) return { success: false, error: 'GEMINI_API_KEY não configurada', data: null };

    const parts = (sheetParts || []).filter((p) => p.snippet && String(p.snippet).trim());
    if (!parts.length) return { success: false, error: 'Sem trechos de planilha', data: null };
    const body = parts
      .map((p) => `#### Aba "${String(p.sheetName || 'Planilha').replace(/"/g, '')}"\n${String(p.snippet).slice(0, 17500)}`)
      .join('\n\n')
      .slice(0, 80000);
    const prompt = `Você interpreta arquivos de VENDAS (Excel) brasileiros com UMA OU MAIS ABAS.
Arquivo: ${filename}

Abaixo há trechos de várias abas (cabeçalho + linhas). Cada aba pode ter colunas diferentes.
Extraia TODAS as linhas que representam vendas/recebimentos em qualquer aba. Ignore totais, subtotais, linhas em branco e cabeçalhos repetidos.

${body}

Responda SOMENTE com JSON válido, sem markdown:
{"sales":[{"sale_date":"YYYY-MM-DD","gross_value":0,"discount":0,"net_value":0,"payment_method":"pix|dinheiro|credito|debito|boleto|transferencia|voucher|cupom|outros|null","quantity":1,"cancelled":false,"revenue_category":null,"__sheet":"nome da aba se souber"}]}

Use __sheet quando conseguir inferir a aba.
Opcional revenue_category: nome EXATO de uma receita do plano (lista igual ao modo CSV), ou null.

payment_method: pix|dinheiro|credito|debito|boleto|transferencia|voucher|cupom|outros|null — inferir a partir dos nomes das colunas e células (PIX, cartão, dinheiro, voucher, boleto, etc.); evite "outros" se houver evidência clara no layout brasileiro de PDV.

Se não houver vendas: {"sales":[]}.`;

    try {
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: textJsonGenerationConfig,
      });
      let text;
      try {
        text = result.response.text().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      } catch (e) {
        return { success: false, error: formatGeminiApiError(e?.message || String(e)), data: null };
      }
      const data = parseGeminiJson(text);
      if (!data || !Array.isArray(data.sales)) {
        return { success: false, error: 'Resposta sem array sales', data: null };
      }
      return { success: true, data };
    } catch (err) {
      const msg = err?.message || err?.cause?.message || String(err);
      logger.error(`Gemini readSalesWorkbook error: ${msg}`);
      return { success: false, error: formatGeminiApiError(msg), data: null };
    }
  }

  /**
   * Sugere categoria para um lançamento baseado na descrição e histórico.
   */
  async suggestCategory(description, amount, availableCategories, history = []) {
    const model = this.getModel();
    if (!model) return { category: null, confidence: 0, reason: 'GEMINI_API_KEY ausente' };

    const prompt = `Você é um contador brasileiro especialista em classificação contábil.
Classifique o lançamento bancário abaixo escolhendo NO MÁXIMO UMA categoria da lista (ou deixe category null se não houver evidência clara no texto).

Regras:
- Baseie-se EXCLUSIVAMENTE no texto do lançamento (nome do favorecido, descrição do PIX/TED, estabelecimento, etc.).
- NÃO invente contexto (ex.: não assuma "compra de mercadoria" só porque é um pagamento genérico).
- NÃO escolha categoria genérica se o texto não contiver palavras relacionadas a ela.
- Se o texto for vago ("TRANSF", "PAG", "PIX") sem setor ou fornecedor identificável, use category: null e confidence baixa.
- Pagamentos a fabricantes/distribuidores de bebidas (Coca-Cola, Ambev, Pepsico, refrigerante, cerveja, água, suco industrializado) → categoria de CMV / mercadoria / bebidas do plano, NUNCA "Frete" nem "Impostos" salvo o texto citar explicitamente frete ou tributo.
- "Frete e transporte" só se houver palavras como frete, transportadora, logística, correios, entrega — não use frete só porque o valor é alto ou é PIX para fornecedor.

Lançamento: "${description}"
Valor: R$ ${Math.abs(amount)} (${amount < 0 ? 'débito/saída' : 'crédito/entrada'})

Histórico de classificações similares: ${JSON.stringify(history.slice(0, 25))}

Lista EXATA de categorias (cada linha pode ser "CÓDIGO — Nome" ou só o nome; copie UMA linha inteira quando for o caso):
${availableCategories.map((n) => `- ${n}`).join('\n')}

{
  "category": "EXATAMENTE um item da lista acima, ou null se não houver correspondência clara",
  "confidence": número de 0 a 1,
  "reason": "motivo em uma frase curta"
}`;

    try {
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: textJsonGenerationConfig,
      });
      let text;
      try {
        text = result.response.text().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      } catch (e) {
        return { category: null, confidence: 0, reason: formatGeminiApiError(e?.message || String(e)) };
      }
      const parsed = parseGeminiJson(text);
      if (!parsed) return { category: null, confidence: 0, reason: 'JSON inválido' };
      return parsed;
    } catch (err) {
      const msg = err?.message || err?.cause?.message || String(err);
      logger.error(`Gemini suggestCategory error: ${msg}`);
      return { category: null, confidence: 0, reason: formatGeminiApiError(msg) };
    }
  }
}

const geminiReaderSingleton = new GeminiDocReader();
geminiReaderSingleton.normalizeMimeType = normalizeMimeType;
module.exports = geminiReaderSingleton;
