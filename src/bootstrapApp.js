const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const companyRoutes = require('./routes/companies');
const nfeRoutes = require('./routes/nfe');
const payableRoutes = require('./routes/payables');
const salesRoutes = require('./routes/sales');
const bankRoutes = require('./routes/bank');
const docRoutes = require('./routes/documents');
const reportRoutes = require('./routes/reports');
const userRoutes = require('./routes/users');
const logRoutes = require('./routes/logs');

const { errorHandler } = require('./middlewares/errorHandler');

const DEFAULT_CORS = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'https://rocketrocket-64c29.web.app',
  'https://rocketrocket-64c29.firebaseapp.com',
  /* Domínio customizado no Firebase Hosting (docs/DEPLOY.md) */
  'https://app.rocketconsultoria.com',
];

function corsOriginList() {
  const extra = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const front = process.env.FRONTEND_URL?.trim();
  if (front) extra.push(front);
  return [...new Set([...DEFAULT_CORS, ...extra])];
}

function corsOriginAllowed(origin) {
  if (!origin) return true;
  const allowed = corsOriginList();
  if (allowed.includes(origin)) return true;
  if (process.env.TRUST_RAILWAY_ORIGINS === 'true' && /\.up\.railway\.app$/i.test(origin)) return true;
  return false;
}

function renderLandingPage() {
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Rocket ERP</title>
    <style>
      :root {
        color-scheme: light dark;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: Inter, Arial, sans-serif;
        background: #f4f6f8;
        color: #151b26;
      }

      .shell {
        max-width: 1080px;
        margin: 0 auto;
        padding: 48px 24px;
      }

      .hero {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 32px;
        align-items: center;
      }

      .hero-copy h1 {
        margin: 0 0 12px;
        font-size: clamp(1.9rem, 3.6vw, 2.8rem);
      }

      .hero-copy p {
        margin: 0;
        line-height: 1.55;
        color: #334155;
      }

      .video-placeholder {
        width: 100%;
        aspect-ratio: 16 / 9;
        background: #0f172a;
        border-radius: 16px;
        display: grid;
        place-items: center;
        text-align: center;
        padding: 20px;
        box-shadow: 0 16px 36px rgba(15, 23, 42, 0.22);
      }

      .play-button {
        width: 74px;
        height: 74px;
        border: 0;
        border-radius: 999px;
        background: #f97316;
        color: #ffffff;
        font-size: 30px;
        line-height: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 14px;
        cursor: default;
      }

      .video-placeholder p {
        margin: 0;
        color: #e2e8f0;
        font-weight: 600;
      }

      @media (max-width: 900px) {
        .hero {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="hero">
        <div class="hero-copy">
          <h1>Rocket ERP API</h1>
          <p>Serviço ativo para autenticação, cadastros, financeiro e relatórios.</p>
        </div>

        <div class="video-placeholder" aria-label="Placeholder de vídeo">
          <div>
            <button class="play-button" type="button" aria-hidden="true">&#9654;</button>
            <p>Em breve — demo do sistema</p>
          </div>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

/**
 * Middlewares + rotas (carregado depois de app.listen no index — Cloud Run vê /health cedo).
 * @param {import('express').Express} app
 */
function bootstrapApp(app) {
  app.get('/', (req, res) => {
    res.type('html').send(renderLandingPage());
  });

  app.use(helmet());

  app.use(
    cors({
      origin(origin, cb) {
        if (corsOriginAllowed(origin)) return cb(null, true);
        return cb(null, false);
      },
      credentials: true,
    }),
  );

  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 300,
      message: { error: 'Muitas requisições. Tente novamente em 15 minutos.' },
    }),
  );

  app.use(
    '/api/auth/login',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 10,
      message: { error: 'Muitas tentativas de login.' },
    }),
  );

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  app.use('/api/auth', authRoutes);
  app.use('/api/companies', companyRoutes);
  app.use('/api/nfe', nfeRoutes);
  app.use('/api/payables', payableRoutes);
  app.use('/api/sales', salesRoutes);
  app.use('/api/bank', bankRoutes);
  app.use('/api/documents', docRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/logs', logRoutes);

  app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada' }));
  app.use(errorHandler);
}

module.exports = bootstrapApp;
