import { Router } from 'express';
import { badRequest } from '../utils/httpError.js';

/**
 * Webhook WhatsApp Business (appelé par Meta, sans JWT) :
 *  GET  /api/whatsapp/webhook → vérification de l'abonnement (hub.verify_token)
 *  POST /api/whatsapp/webhook → accusés de réception / lecture / échec et messages « STOP »,
 *                               authentifiés par la signature X-Hub-Signature-256 (clé secrète de l'application Meta)
 */
export function whatsappRouter({ whatsappService }) {
  const router = Router();

  router.get('/webhook', (req, res) => {
    res.type('text/plain').send(whatsappService.verifyChallenge(req.query));
  });

  router.post('/webhook', async (req, res) => {
    if (!req.rawBody) throw badRequest('Corps JSON attendu (Content-Type: application/json).');
    const result = await whatsappService.handleWebhook(req.rawBody, req.get('x-hub-signature-256'));
    res.status(200).json({ success: true, ...result });
  });

  return router;
}
