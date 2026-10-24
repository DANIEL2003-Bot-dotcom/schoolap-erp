import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { dashboardRouters } from './routes/dashboard.js';
import { paymentsRouter } from './routes/payments.js';
import { syncRouters } from './routes/sync.js';
import { teacherRouter } from './routes/teacher.js';
import { createAdminService } from './services/admin.js';
import { createAttendanceService } from './services/attendance.js';
import { createDashboardService } from './services/dashboard.js';
import { createFeesService } from './services/fees.js';
import { createGradesService } from './services/grades.js';
import { createMobileMoneyService } from './services/mobileMoney.js';
import { createSmsService } from './services/sms.js';
import { logger } from './utils/logger.js';

export function createApp({ prisma, config, overrides = {} }) {
  const sms = overrides.sms ?? createSmsService({ prisma, config, print: overrides.smsPrint });
  const feesService = createFeesService({ prisma, sms, config });
  const attendanceService = createAttendanceService({ prisma, sms, config });
  const gradesService = createGradesService({ prisma });
  const mobileMoneyService = createMobileMoneyService({ prisma, sms, config, dispatchWebhook: overrides.dispatchWebhook });
  const adminService = createAdminService({ prisma, config });
  const dashboardService = createDashboardService({ prisma, fees: feesService, timezone: config.timezone });

  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      // Les applications mobiles n'envoient pas d'en-tête Origin : elles sont acceptées.
      origin(origin, callback) {
        if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`CORS: origine refusée ${origin}`));
      },
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Signature'],
      maxAge: 86_400,
    }),
  );
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        req.rawBody = buf; // conservé pour vérifier la signature HMAC des webhooks
      },
    }),
  );
  if (config.logRequests) {
    app.use((req, res, next) => {
      const start = process.hrtime.bigint();
      res.on('finish', () => {
        const path = req.originalUrl.split('?')[0];
        if (path === '/api/health') return;
        logger.info('requête', {
          method: req.method,
          path,
          status: res.statusCode,
          ms: Number((process.hrtime.bigint() - start) / 1_000_000n),
        });
      });
      next();
    });
  }

  app.get('/', (_req, res) => res.json({ name: 'ERP scolaire RDC — API', status: 'ok', health: '/api/health' }));
  app.get('/api/health', async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  const sync = syncRouters({ prisma, config, attendanceService, gradesService });
  const admin = dashboardRouters({ prisma, config, dashboardService, feesService });

  app.use('/api/auth', authRouter({ prisma, config }));
  app.use('/api/teacher', teacherRouter({ prisma, config }));
  app.use('/api/attendance', sync.attendance);
  app.use('/api/grades', sync.grades);
  app.use('/api/payments', paymentsRouter({ config, mobileMoneyService }));
  app.use('/api/dashboard', admin.dashboard);
  app.use('/api/fees', admin.fees);
  app.use('/api/admin', adminRouter({ prisma, config, adminService }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, services: { sms, adminService, feesService, attendanceService, gradesService, mobileMoneyService, dashboardService } };
}
