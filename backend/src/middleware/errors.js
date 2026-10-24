import { HttpError, notFound } from '../utils/httpError.js';
import { logger } from '../utils/logger.js';

export function notFoundHandler(req, _res, next) {
  next(notFound(`Route introuvable : ${req.method} ${req.path}`));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Erreur interne du serveur. Réessayez plus tard.';
  let details;

  if (err instanceof HttpError) {
    ({ status, code, message, details } = err);
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
    code = 'INVALID_JSON';
    message = 'Le corps de la requête n’est pas un JSON valide.';
  } else if (err?.type === 'entity.too.large') {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'Requête trop volumineuse : envoyez les données par lots plus petits.';
  } else if (err?.message?.startsWith('CORS:')) {
    status = 403;
    code = 'CORS_REJECTED';
    message = 'Origine non autorisée.';
  }

  if (status >= 500) logger.error('Erreur non gérée', { path: req.path, method: req.method, err: err?.stack ?? String(err) });

  if (res.headersSent) return;
  res.status(status).json({ success: false, error: { code, message, ...(details !== undefined ? { details } : {}) } });
}
