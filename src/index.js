require('dotenv').config();
const express = require('express');
const logger = require('./utils/logger');

process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', { reason: reason instanceof Error ? reason.message : String(reason) });
});
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { message: err.message, stack: err.stack });
});

const app = express();
app.set('trust proxy', 1);

const portStr = String(process.env.PORT ?? '').trim();
const parsed = parseInt(portStr, 10);
const PORT = Number.isFinite(parsed) && parsed > 0 ? parsed : 3001;
const LISTEN_HOST = (process.env.LISTEN_HOST || '0.0.0.0').trim() || '0.0.0.0';

const healthHandler = (req, res) => res.json({ status: 'ok', ts: new Date() });
app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

const server = app.listen(PORT, LISTEN_HOST, () => {
  logger.info(`Rocket ERP API em http://${LISTEN_HOST}:${PORT} [${process.env.NODE_ENV || 'undefined'}]`);
});

/* Deferir: se o require() das rotas rodar na mesma volta síncrona do listen(), o bind atrasa e o health check do Cloud Run falha. */
setImmediate(() => {
  try {
    require('./bootstrapApp')(app);
  } catch (err) {
    logger.error('Falha ao carregar rotas', { message: err.message, stack: err.stack });
    /* Não dar process.exit(1): derruba a revisão no Cloud Run (503 em loop). Sem Supabase nas env vars é esperado até configurar. */
    app.use((req, res) => {
      res.status(503).json({
        error: 'API não inicializada',
        detail: String(err.message),
        hint:
          'No Google Cloud Run → serviço rocket-erp-api → Editar e implantar → Variáveis: defina SUPABASE_URL, SUPABASE_SERVICE_KEY e JWT_SECRET (mesmos valores do backend/.env). Depois dispare uma nova revisão.',
      });
    });
  }
});

server.keepAliveTimeout = 75000;
server.headersTimeout = 95000;
server.timeout = 180000;

module.exports = app;
