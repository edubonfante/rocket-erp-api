const router = require('express').Router();

const TERMS_HTML = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Termos de Uso | Rocket ERP</title>
    <style>
      :root {
        color-scheme: light dark;
      }
      body {
        margin: 0;
        font-family: Arial, Helvetica, sans-serif;
        line-height: 1.6;
        background: #f5f7fb;
        color: #111827;
      }
      main {
        max-width: 860px;
        margin: 0 auto;
        padding: 2rem 1rem 3rem;
      }
      section {
        background: #ffffff;
        border-radius: 12px;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
        padding: 1.25rem 1.5rem;
        margin-bottom: 1rem;
      }
      h1, h2 {
        margin: 0 0 0.75rem;
      }
      p {
        margin: 0.5rem 0;
      }
      ul {
        margin: 0.5rem 0 0.5rem 1.25rem;
      }
      small {
        display: block;
        margin-top: 1rem;
        color: #4b5563;
      }
      @media (max-width: 640px) {
        section {
          padding: 1rem;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section>
        <h1>Termos de Uso</h1>
        <p>
          Estes Termos de Uso regem o acesso e a utilizacao da plataforma Rocket ERP.
          Ao utilizar o sistema, voce concorda com estas condicoes.
        </p>
        <small>Ultima atualizacao: 17/05/2026</small>
      </section>
      <section>
        <h2>1. Uso da plataforma</h2>
        <p>
          O usuario deve utilizar a plataforma de forma licita, sem comprometer a
          seguranca, a disponibilidade ou a integridade dos dados.
        </p>
      </section>
      <section>
        <h2>2. Conta e credenciais</h2>
        <p>
          O usuario e responsavel por manter suas credenciais em sigilo e por toda
          atividade realizada em sua conta.
        </p>
      </section>
      <section>
        <h2>3. Privacidade e dados</h2>
        <p>
          O tratamento de dados segue nossa Politica de Privacidade e a legislacao
          aplicavel, incluindo a Lei Geral de Protecao de Dados (LGPD).
        </p>
      </section>
      <section>
        <h2>4. Limitacao de responsabilidade</h2>
        <p>
          A Rocket ERP envida esforcos razoaveis para manter a operacao da plataforma,
          mas nao garante disponibilidade ininterrupta ou ausencia total de falhas.
        </p>
      </section>
      <section>
        <h2>5. Alteracoes nos termos</h2>
        <p>
          Estes termos podem ser atualizados periodicamente. A versao vigente estara
          sempre disponivel nesta pagina.
        </p>
      </section>
    </main>
  </body>
</html>`;

router.get('/termos', (req, res) => {
  res.type('html').status(200).send(TERMS_HTML);
});

module.exports = router;
