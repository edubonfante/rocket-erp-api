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

/**
 * Middlewares + rotas (carregado depois de app.listen no index — Cloud Run vê /health cedo).
 * @param {import('express').Express} app
 */
function bootstrapApp(app) {
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
