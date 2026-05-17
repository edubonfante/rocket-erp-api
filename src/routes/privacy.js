const express = require('express');

const router = express.Router();

const privacyPolicyHtml = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Politica de Privacidade - Rocket ERP</title>
    <style>
      :root {
        color-scheme: light dark;
      }
      body {
        margin: 0;
        font-family: Arial, sans-serif;
        line-height: 1.6;
      }
      main {
        max-width: 860px;
        margin: 40px auto;
        padding: 0 20px 40px;
      }
      h1, h2 {
        line-height: 1.25;
      }
      p, li {
        font-size: 16px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Politica de Privacidade (LGPD)</h1>
      <p><strong>Ultima atualizacao:</strong> 17/05/2026</p>
      <p>
        Esta Politica de Privacidade descreve como o Rocket ERP trata dados pessoais em conformidade
        com a Lei Geral de Protecao de Dados (Lei no 13.709/2018 - LGPD).
      </p>

      <h2>1. Dados tratados</h2>
      <ul>
        <li>Dados cadastrais e de identificacao profissional fornecidos no uso da plataforma.</li>
        <li>Dados fiscais, financeiros e operacionais inseridos para uso das funcionalidades do ERP.</li>
        <li>Registros tecnicos de acesso, seguranca e auditoria da aplicacao.</li>
      </ul>

      <h2>2. Finalidades do tratamento</h2>
      <ul>
        <li>Viabilizar a prestacao dos servicos contratados.</li>
        <li>Cumprir obrigacoes legais e regulatorias.</li>
        <li>Prevenir fraudes, garantir seguranca e melhorar a experiencia do usuario.</li>
      </ul>

      <h2>3. Compartilhamento</h2>
      <p>
        O compartilhamento de dados ocorre apenas quando necessario para execucao dos servicos,
        cumprimento de obrigacao legal ou mediante determinacao de autoridade competente.
      </p>

      <h2>4. Direitos do titular</h2>
      <p>
        Nos termos da LGPD, o titular pode solicitar confirmacao de tratamento, acesso, correcao,
        anonimizacao, portabilidade, eliminacao e informacoes sobre compartilhamento, quando aplicavel.
      </p>

      <h2>5. Retencao e seguranca</h2>
      <p>
        Os dados sao armazenados pelo periodo necessario para atender as finalidades declaradas e
        obrigacoes legais, com adocao de medidas tecnicas e administrativas para protecao contra
        acessos nao autorizados e incidentes.
      </p>

      <h2>6. Contato</h2>
      <p>
        Para solicitar informacoes relacionadas a privacidade e protecao de dados, utilize os canais
        oficiais de atendimento da Rocket ERP.
      </p>
    </main>
  </body>
</html>
`;

router.get('/privacidade', (req, res) => {
  res.type('html');
  res.status(200).send(privacyPolicyHtml);
});

module.exports = router;
