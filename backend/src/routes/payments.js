import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { badRequest } from '../utils/httpError.js';

/**
 * POST /api/payments/mobile-money                 → initie un paiement (JWT, permission MANAGE_FEES)
 * POST /api/payments/mobile-money/webhook         → confirmation signée de l'opérateur (HMAC-SHA256, sans JWT)
 * GET  /api/payments/mobile-money/:transactionId  → suivi du statut (JWT, permission MANAGE_FEES)
 */
export function paymentsRouter({ prisma, config, mobileMoneyService }) {
  const router = Router();
  const cashier = [requireAuth({ prisma, config }), requirePermission('MANAGE_FEES')];
  const initLimiter = rateLimit({
    windowMs: 60_000,
    limit: config.isTest ? 10_000 : 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) =>
      res.status(429).json({ success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Trop de demandes de paiement. Patientez une minute.' } }),
  });

  router.post('/mobile-money', ...cashier, initLimiter, async (req, res) => {
    const result = await mobileMoneyService.initiate(req.body, req.user);
    res.status(202).json({ success: true, ...result });
  });

  router.post('/mobile-money/webhook', async (req, res) => {
    if (!req.rawBody) throw badRequest('Corps JSON attendu (Content-Type: application/json).');
    const result = await mobileMoneyService.handleWebhook(req.rawBody, req.get('x-signature'));
    res.status(200).json({ success: true, ...result });
  });

  router.get('/mobile-money/:transactionId', ...cashier, async (req, res) => {
    const result = await mobileMoneyService.getStatus(req.params.transactionId, req.user);
    res.json({ success: true, ...result });
  });

  return router;
}
