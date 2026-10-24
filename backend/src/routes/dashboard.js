import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { isValidIsoDate, todayIn } from '../utils/dates.js';
import { parseOrThrow } from '../utils/httpError.js';

const querySchema = z.object({
  date: z.string().refine(isValidIsoDate, 'date invalide (AAAA-MM-JJ).').optional(),
});
const feeParams = z.object({ feeId: z.uuid({ error: 'Identifiant de frais invalide.' }) });

/** Routes du tableau de bord de la direction. */
export function dashboardRouters({ prisma, config, dashboardService, feesService }) {
  const auth = [requireAuth({ prisma, config }), requireRole('DIRECTOR', 'ADMIN', 'BURSAR')];

  const dashboard = Router();
  dashboard.get('/summary', ...auth, async (req, res) => {
    const { date } = parseOrThrow(querySchema, req.query);
    const summary = await dashboardService.summary(req.user, date ?? todayIn(config.timezone));
    res.json({ success: true, ...summary });
  });

  const fees = Router();
  fees.post('/:feeId/remind', ...auth, async (req, res) => {
    const { feeId } = parseOrThrow(feeParams, req.params);
    const result = await feesService.sendReminder(req.user, feeId);
    res.json({ success: true, ...result });
  });

  return { dashboard, fees };
}
