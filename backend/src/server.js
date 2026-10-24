import { PrismaClient } from '@prisma/client';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { logger } from './utils/logger.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const prisma = new PrismaClient();
const { app, services } = createApp({ prisma, config });

const server = app.listen(config.port, '0.0.0.0', async () => {
  logger.info('API ERP scolaire démarrée', { port: config.port, env: config.env, cors: config.corsOrigins });
  try {
    const updated = await services.feesService.refreshStatuses();
    logger.info('Statuts des frais recalculés', { updated });
  } catch (err) {
    logger.error('Recalcul initial des frais impossible', { err: err.message });
  }
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 65_000; // supérieur au keep-alive du proxy Render

// Une échéance qui passe rend un frais INSOLVABLE : recalcul toutes les heures.
const feeTimer = setInterval(() => {
  services.feesService.refreshStatuses().catch((err) => logger.error('Recalcul des frais en échec', { err: err.message }));
}, 3_600_000);
feeTimer.unref();

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info('Arrêt demandé', { signal });
  server.close(async () => {
    await prisma.$disconnect();
    logger.info('Serveur arrêté proprement');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error('Promesse rejetée non gérée', { err: String(reason?.stack ?? reason) }));
