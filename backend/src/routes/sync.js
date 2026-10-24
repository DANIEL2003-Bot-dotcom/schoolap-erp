import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { requireAuth, requirePermission } from '../middleware/auth.js';

/** POST /api/attendance/sync et POST /api/grades/sync (application mobile). */
export function syncRouters({ prisma, config, attendanceService, gradesService }) {
  const authenticate = requireAuth({ prisma, config });
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: config.isTest ? 10_000 : 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => req.user.id,
    handler: (_req, res) =>
      res.status(429).json({ success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Trop de synchronisations. Réessayez dans une minute.' } }),
  });

  const attendance = Router();
  attendance.post('/sync', authenticate, requirePermission('TAKE_ATTENDANCE'), limiter, async (req, res) => {
    const result = await attendanceService.syncBatch(req.user, req.body);
    res.status(200).json({ success: true, ...result });
  });

  const grades = Router();
  grades.post('/sync', authenticate, requirePermission('ENTER_GRADES'), limiter, async (req, res) => {
    const result = await gradesService.syncBatch(req.user, req.body);
    res.status(200).json({ success: true, ...result });
  });

  return { attendance, grades };
}
