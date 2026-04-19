const winston = require('winston');

/** Cloud Run define K_SERVICE; evita gravar em disco (stdout → Cloud Logging). */
const isCloudRun = Boolean(process.env.K_SERVICE);

const lineFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  ...(isCloudRun ? [] : [winston.format.colorize()]),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `${timestamp} [${level}] ${message}${extra}`;
  }),
);

const transports = [new winston.transports.Console({ format: lineFormat })];

if (!isCloudRun) {
  transports.push(
    new winston.transports.File({ filename: 'logs/error.log', level: 'error', format: lineFormat }),
    new winston.transports.File({ filename: 'logs/combined.log', format: lineFormat }),
  );
}

const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  transports,
});

module.exports = logger;
