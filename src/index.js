require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes      = require('./routes/auth');
const companyRoutes   = require('./routes/companies');
const nfeRoutes       = require('./routes/nfe');
const payableRoutes   = require('./routes/payables');
const salesRoutes     = require('./routes/sales');
const bankRoutes      = require('./routes/bank');
const docRoutes       = require('./routes/documents');
const reportRoutes    = require('./routes/reports');
const userRoutes      = require('./routes/users');
const logRoutes       = require('./routes/logs');

const { errorHandler } = require('./middlewares/errorHandler');
const logger = require('./utils/logger');

process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', { reason: reason instanceof Error ? reason.message : String(reason) });
});
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { message: err.message, stack: err.stack });
});

const app = express();
const PORT = process.env.PORT || 3001;

// ── Segurança ──
app.use(helmet());
app.use(cors({
  origin: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173').split(','),
  credentials: true,
}));

// ── Rate limit global ──
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 300,
  message: { error: 'Muitas requisições. Tente novamente em 15 minutos.' }
}));

// ── Rate limit agressivo no login ──
app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Muitas tentativas de login.' }
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ── Health check ──
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date() }));

// ── Rotas ──
app.use('/api/auth',      authRoutes);
app.use('/api/companies', companyRoutes);
app.use('/api/nfe',       nfeRoutes);
app.use('/api/payables',  payableRoutes);
app.use('/api/sales',     salesRoutes);
app.use('/api/bank',      bankRoutes);
app.use('/api/documents', docRoutes);
app.use('/api/reports',   reportRoutes);
app.use('/api/users',     userRoutes);
app.use('/api/logs',      logRoutes);

// ── 404 ──
app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

// ── Error handler ──
app.use(errorHandler);

const server = app.listen(PORT, () => {
  logger.info(`🚀 Rocket ERP API rodando na porta ${PORT} [${process.env.NODE_ENV}]`);
});

/* Proxies (Railway, etc.): evita socket fechado em requests longos (ex.: Gemini + upload). */
server.keepAliveTimeout = 75000;
server.headersTimeout = 95000;
server.timeout = 180000;

module.exports = app;
