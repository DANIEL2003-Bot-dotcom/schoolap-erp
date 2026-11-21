import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { isValidIsoDate, todayIn } from '../utils/dates.js';
import { parseOrThrow } from '../utils/httpError.js';

const querySchema = z.object({
  date: z.string().refine(isValidIsoDate, 'date invalide (AAAA-MM-JJ).').optional(),
});
const alertParams = z.object({ alertId: z.uuid({ error: 'Identifiant d’alerte invalide.' }) });
const feeParams = z.object({ feeId: z.uuid({ error: 'Identifiant de frais invalide.' }) });
const messageParams = z.object({ messageId: z.uuid({ error: 'Identifiant de message invalide.' }) });

/** Routes du tableau de bord de la direction. */
export function dashboardRouters({ prisma, config, dashboardService, feesService, performanceService, messagingService }) {
  const authenticate = requireAuth({ prisma, config });

  const dashboard = Router();
  dashboard.get('/summary', authenticate, requirePermission('VIEW_SCHOOL'), async (req, res) => {
    const { date } = parseOrThrow(querySchema, req.query);
    const summary = await dashboardService.summary(req.user, date ?? todayIn(config.timezone));
    res.json({ success: true, ...summary });
  });

  /** Alertes de résultats : liste complète et « marquer comme suivi » par la direction (pas la comptabilité). */
  dashboard.get('/performance-alerts', authenticate, requirePermission('VIEW_ACADEMIC'), async (req, res) => {
    const overview = await performanceService.schoolOverview(req.user, 500);
    res.json({ success: true, ...overview });
  });
  dashboard.post('/performance-alerts/:alertId/acknowledge', authenticate, requirePermission('VIEW_ACADEMIC'), async (req, res) => {
    const { alertId } = parseOrThrow(alertParams, req.params);
    const alert = await performanceService.acknowledge(req.user, alertId, req.body);
    res.json({ success: true, alert });
  });

  /** Message WhatsApp non distribué : l'école a joint le parent autrement (appel, convocation). */
  dashboard.post('/messages/:messageId/handled', authenticate, requirePermission('VIEW_SCHOOL'), async (req, res) => {
    const { messageId } = parseOrThrow(messageParams, req.params);
    res.json({ success: true, ...(await messagingService.markHandled(req.user, messageId)) });
  });

  const fees = Router();
  fees.post('/:feeId/remind', authenticate, requirePermission('COLLECT_PAYMENTS'), async (req, res) => {
    const { feeId } = parseOrThrow(feeParams, req.params);
    const result = await feesService.sendReminder(req.user, feeId);
    res.json({ success: true, ...result });
  });

  return { dashboard, fees };
}
