const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('../utils/logger');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Serviço de leitura inteligente de documentos via Gemini Vision.
 * Lê foto de nota, cupom, recibo, boleto e extrai os dados estruturados.
 */
class GeminiDocReader {

  constructor() {
    this.model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  }

  /**
   * Analisa imagem de documento e retorna dados estruturados.
   * @param {Buffer} imageBuffer — buffer da imagem
   * @param {string} mimeType    — 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf'
   * @returns {Object} dados extraídos
   */
  async readDocument(imageBuffer, mimeType = 'image/jpeg') {
    const prompt = `Você é um sistema especialista em contabilidade brasileira.
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
      "ncm": "código NCM 4-8 dígitos ou null",
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

Categorias disponíveis para o campo "category" de cada item:
- Bovinos (carnes bovinas, boi, frango nao, apenas bovinos)
- Aves (frango, peru, pato, chester)
- Suinos (porco, bacon, linguica suina)
- Peixes (peixe, frutos do mar, camarao)
- Embutidos (salsicha, presunto, salame, mortadela, linguica)
- Laticinios (leite, queijo, iogurte, manteiga, creme de leite)
- Hortifruti (frutas, verduras, legumes, ovos)
- Padaria (pao, bolo, biscoito, farinha, achocolatado)
- Secos (arroz, feijao, acucar, sal, farinha, graos)
- Massas Molhos Temperos (macarrao, molho, ketchup, mostarda, tempero, azeite vinagre)
- Oleos Azeites (oleo de soja, azeite, vinagre)
- Cafe Sobremesas (cafe, cha, achocolatado, sorvete, chocolate)
- Cervejas (cerveja, chope)
- Destilados (vodka, whisky, cachaca, vinho, espumante)
- Agua Refrigerantes (agua, refrigerante, suco industrializado)
- Energeticos (red bull, monster, energetico)
- Embalagens Descartaveis (copo descartavel, prato descartavel, sacola, papel aluminio, plastico)
- Gelo (gelo)
- Congelados (produto congelado, pizza, lasanha)
- Higiene Limpeza (sabao, detergente, desinfetante, alcool, papel higienico, produto de limpeza, vassoura, esponja, alvejante, multiuso)
- Outros (demais itens nao classificados acima)

IMPORTANTE: Alcool de limpeza = Higiene Limpeza. Papel higienico = Higiene Limpeza. Detergente = Higiene Limpeza.

Seja preciso. Se não tiver certeza de um campo, use null.`;

    try {
      const imagePart = {
        inlineData: {
          data: imageBuffer.toString('base64'),
          mimeType,
        },
      };

      const result = await this.model.generateContent([prompt, imagePart]);
      const text   = result.response.text().trim();

      // Remove possíveis blocos markdown que o modelo às vezes inclui
      const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const data  = JSON.parse(clean);

      logger.info(`Gemini leu documento: ${data.doc_type} | R$ ${data.total_value} | confiança: ${data.confidence}`);
      return { success: true, data };

    } catch (err) {
      logger.error('Gemini readDocument error:', err.message);
      return { success: false, error: err.message, data: null };
    }
  }

  /**
   * Analisa múltiplas páginas (ex: PDF multipágina convertido em imagens).
   */
  async readMultiPage(pages) {
    const results = await Promise.all(
      pages.map(p => this.readDocument(p.buffer, p.mimeType))
    );
    // Mescla resultados — usa o de maior confiança como base
    const best = results.filter(r => r.success).sort((a, b) => b.data.confidence - a.data.confidence)[0];
    return best || { success: false, error: 'Nenhuma página lida com sucesso' };
  }

  /**
   * Lê extrato bancário e retorna lista de transações estruturadas.
   */
  async readBankStatement(imageBuffer, mimeType = 'image/jpeg') {
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
      "doc_number": "número do documento ou null"
    }
  ]
}`;

    try {
      const imagePart = { inlineData: { data: imageBuffer.toString('base64'), mimeType } };
      const result = await this.model.generateContent([prompt, imagePart]);
      const text = result.response.text().replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
      return { success: true, data: JSON.parse(text) };
    } catch (err) {
      logger.error('Gemini readBankStatement error:', err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Interpreta trecho de planilha/CSV de vendas e devolve linhas normalizadas.
   * Usado quando o parser heurístico não encontra colunas de data/valor.
   */
  async readSalesSnippet(filename, sheetLabel, textSnippet) {
    const snippet = String(textSnippet || '').slice(0, 14000);
    const prompt = `Você interpreta exportações de vendas de PDV/ERP brasileiros.
Arquivo: ${filename}
Planilha/bloco: ${sheetLabel}

Trecho (cabeçalho + linhas; pode ser TAB ou vírgula):
${snippet}

Tarefa: identificar cada LINHA DE VENDA individual (ignore linhas só de total, subtotal, taxa, cabeçalho repetido).
Responda SOMENTE com JSON válido, sem markdown:
{"sales":[{"sale_date":"YYYY-MM-DD","gross_value":0,"discount":0,"net_value":0,"payment_method":"pix|dinheiro|credito|debito|boleto|transferencia|voucher|cupom|outros|null","quantity":1,"cancelled":false}]}

Regras:
- Valores são números decimais sem "R$" ou texto.
- Se só existir um valor por linha, coloque em net_value e gross_value igual.
- payment_method: normalize para os valores listados; se desconhecido use "outros".
- cancelled true se a linha indicar cancelamento/estorno.
- Se não houver vendas: {"sales":[]}.`;

    try {
      const result = await this.model.generateContent(prompt);
      const text = result.response.text().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.sales)) return { success: false, error: 'Resposta sem array sales', data: null };
      return { success: true, data };
    } catch (err) {
      logger.error('Gemini readSalesSnippet error:', err.message);
      return { success: false, error: err.message, data: null };
    }
  }

  /**
   * Várias abas de Excel: envia trechos rotulados e recebe um único array `sales`.
   */
  async readSalesWorkbook(filename, sheetParts) {
    const parts = (sheetParts || []).filter((p) => p.snippet && String(p.snippet).trim());
    if (!parts.length) return { success: false, error: 'Sem trechos de planilha', data: null };
    const body = parts
      .map((p) => `#### Aba "${String(p.sheetName || 'Planilha').replace(/"/g, '')}"\n${String(p.snippet).slice(0, 3500)}`)
      .join('\n\n')
      .slice(0, 16000);
    const prompt = `Você interpreta arquivos de VENDAS (Excel) brasileiros com UMA OU MAIS ABAS.
Arquivo: ${filename}

Abaixo há trechos de várias abas (cabeçalho + linhas). Cada aba pode ter colunas diferentes.
Extraia TODAS as linhas que representam vendas/recebimentos em qualquer aba. Ignore totais, subtotais, linhas em branco e cabeçalhos repetidos.

${body}

Responda SOMENTE com JSON válido, sem markdown:
{"sales":[{"sale_date":"YYYY-MM-DD","gross_value":0,"discount":0,"net_value":0,"payment_method":"pix|dinheiro|credito|debito|boleto|transferencia|voucher|cupom|outros|null","quantity":1,"cancelled":false,"__sheet":"nome da aba se souber"}]}

Use __sheet quando conseguir inferir a aba. Se não houver vendas: {"sales":[]}.`;

    try {
      const result = await this.model.generateContent(prompt);
      const text = result.response.text().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.sales)) return { success: false, error: 'Resposta sem array sales', data: null };
      return { success: true, data };
    } catch (err) {
      logger.error('Gemini readSalesWorkbook error:', err.message);
      return { success: false, error: err.message, data: null };
    }
  }

  /**
   * Sugere categoria para um lançamento baseado na descrição e histórico.
   * Útil para a conciliação bancária.
   */
  async suggestCategory(description, amount, availableCategories, history = []) {
    const prompt = `Você é um contador brasileiro especialista em classificação contábil.
Classifique o lançamento bancário abaixo escolhendo UMA das categorias da lista.
Responda SOMENTE com JSON, sem markdown.

Lançamento: "${description}"
Valor: R$ ${Math.abs(amount)} (${amount < 0 ? 'débito/saída' : 'crédito/entrada'})

Histórico de classificações similares: ${JSON.stringify(history.slice(0,5))}

Lista EXATA de categorias (copie o texto de uma delas, caractere por caractere, inclusive acentos):
${availableCategories.map((n) => `- ${n}`).join('\n')}

{
  "category": "deve ser EXATAMENTE igual a um dos itens da lista acima (copie o nome)",
  "confidence": número de 0 a 1,
  "reason": "motivo em uma frase curta"
}`;

    try {
      const result = await this.model.generateContent(prompt);
      const text = result.response.text().replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
      return JSON.parse(text);
    } catch (err) {
      logger.error('Gemini suggestCategory error:', err.message);
      return { category: null, confidence: 0, reason: 'Erro na sugestão' };
    }
  }
}

module.exports = new GeminiDocReader();
// deploy ter 14 abr 2026 23:15:38 -03
