const logger = require('../utils/logger');

function errorHandler(err, req, res, next) {
  logger.error(`${err.message}`, { stack: err.stack, url: req.originalUrl });

  if (err.type === 'entity.too.large')
    return res.status(413).json({ error: 'Arquivo muito grande. Máximo 50MB.' });

  if (err.code === 'LIMIT_FILE_SIZE')
    return res.status(413).json({ error: 'Arquivo muito grande.' });

  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Erro interno do servidor'
      : err.message,
  });
}

module.exports = { errorHandler };
