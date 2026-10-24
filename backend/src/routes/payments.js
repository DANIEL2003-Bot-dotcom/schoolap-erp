import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { badRequest } from '../utils/httpError.js';

/**
 * POST /api/payments/mobile-money                 → initie un paiement (push USSD simulé)
 * POST /api/payments/mobile-money/webhook         → confirmation signée de l'opérateur (HMAC-SHA256)
 * GET  /api/payments/mobile-money/:transactionId  → suivi du statut
 */
export function paymentsRouter({ config, mobileMoneyService }) {
  const router = Router();
  const initLimiter = rateLimit({
    windowMs: 60_000,
    limit: config.isTest ? 10_000 : 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) =>
      res.status(429).json({ success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Trop de demandes de paiement. Patientez une minute.' } }),
  });

  router.post('/mobile-money', initLimiter, async (req, res) => {
    const result = await mobileMoneyService.initiate(req.body);
    res.status(202).json({ success: true, ...result });
  });

  router.post('/mobile-money/webhook', async (req, res) => {
    if (!req.rawBody) throw badRequest('Corps JSON attendu (Content-Type: application/json).');
    const result = await mobileMoneyService.handleWebhook(req.rawBody, req.get('x-signature'));
    res.status(200).json({ success: true, ...result });
  });

  router.get('/mobile-money/:transactionId', async (req, res) => {
    const result = await mobileMoneyService.getStatus(req.params.transactionId);
    res.json({ success: true, ...result });
  });

  return router;
}
