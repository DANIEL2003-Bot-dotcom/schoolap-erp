export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, 'VALIDATION_ERROR', message, details);
export const unauthorized = (message = 'Authentification requise.') => new HttpError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'Accès refusé.') => new HttpError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Ressource introuvable.') => new HttpError(404, 'NOT_FOUND', message);
export const conflict = (message, details) => new HttpError(409, 'CONFLICT', message, details);
export const tooManyRequests = (message, details) => new HttpError(429, 'TOO_MANY_REQUESTS', message, details);

/** Transforme une erreur zod en liste lisible { field, message }. */
export function zodDetails(error) {
  return error.issues.map((i) => ({ field: i.path.join('.') || null, message: i.message }));
}

/** Valide `data` avec un schéma zod ou lève une 400. */
export function parseOrThrow(schema, data, message = 'Requête invalide.') {
  const result = schema.safeParse(data);
  if (!result.success) throw badRequest(message, zodDetails(result.error));
  return result.data;
}
