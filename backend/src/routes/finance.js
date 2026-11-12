import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { isValidIsoDate, todayIn } from '../utils/dates.js';
import { parseOrThrow } from '../utils/httpError.js';

const idParam = z.object({ id: z.uuid({ error: 'Identifiant de paiement invalide.' }) });
const id = (req) => parseOrThrow(idParam, req.params).id;
const dateQuery = z.object({ date: z.string().refine(isValidIsoDate, 'date invalide (AAAA-MM-JJ).').optional() });

/**
 * Caisse (/api/finance/…) — permission COLLECT_PAYMENTS (Comptable, Directeur, Préfet, Admin)
 *  POST /payments                    → encaissement manuel (espèces, banque, Mobile Money reçu sur le téléphone de l'école)
 *  GET  /payments?from&to&method     → journal de caisse (jour ou période, 31 jours maximum)
 *  GET  /summary?date                → indicateurs de caisse du jour
 *  GET  /receipts/:id                → reçu complet à imprimer
 *  POST /receipts/:id/printed        → enregistre une impression (DUPLICATA à partir de la 2e)
 *  POST /payments/:id/cancel         → annulation d'un reçu, motif obligatoire (MANAGE_FEES : direction uniquement)
 */
export function financeRouter({ prisma, config, financeService }) {
  const router = Router();
  router.use(requireAuth({ prisma, config }), requirePermission('COLLECT_PAYMENTS'));

  router.post('/payments', async (req, res) => {
    const result = await financeService.recordPayment(req.user, req.body);
    res.status(result.replayed ? 200 : 201).json({ success: true, ...result });
  });
  router.get('/payments', async (req, res) => res.json({ success: true, ...(await financeService.journal(req.user, req.query)) }));
  router.get('/summary', async (req, res) => {
    const { date } = parseOrThrow(dateQuery, req.query);
    res.json({ success: true, ...(await financeService.daySummary(req.user, date ?? todayIn(config.timezone))) });
  });
  router.get('/receipts/:id', async (req, res) => res.json({ success: true, ...(await financeService.receipt(req.user, id(req))) }));
  router.post('/receipts/:id/printed', async (req, res) => res.json({ success: true, ...(await financeService.markPrinted(req.user, id(req))) }));
  router.post('/payments/:id/cancel', requirePermission('MANAGE_FEES'), async (req, res) =>
    res.json({ success: true, ...(await financeService.cancelPayment(req.user, id(req), req.body)) }),
  );

  return router;
}
