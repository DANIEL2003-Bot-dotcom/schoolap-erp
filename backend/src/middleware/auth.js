import jwt from 'jsonwebtoken';
import { PERMISSIONS } from '../services/roles.js';
import { forbidden, unauthorized } from '../utils/httpError.js';

export function signToken(user, config) {
  return jwt.sign({ role: user.role, schoolId: user.schoolId }, config.jwtSecret, {
    subject: user.id,
    expiresIn: config.jwtExpiresIn,
    issuer: 'schoolap-erp',
  });
}

/** Vérifie le jeton Bearer et recharge l'utilisateur (un compte désactivé perd l'accès immédiatement). */
export function requireAuth({ prisma, config }) {
  return async function authenticate(req, _res, next) {
    const [scheme, token] = (req.get('authorization') ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) return next(unauthorized('Jeton manquant : connectez-vous.'));

    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret, { issuer: 'schoolap-erp' });
    } catch (err) {
      return next(unauthorized(err.name === 'TokenExpiredError' ? 'Session expirée : reconnectez-vous.' : 'Jeton invalide.'));
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, schoolId: true, fullName: true, phone: true, role: true, isActive: true, officeId: true },
    });
    if (!user || !user.isActive) return next(unauthorized('Compte introuvable ou désactivé.'));
    req.user = user;
    return next();
  };
}

export function requireRole(...roles) {
  return function authorize(req, _res, next) {
    if (!req.user || !roles.includes(req.user.role)) return next(forbidden('Votre rôle ne permet pas cette action.'));
    return next();
  };
}

/** Autorise l'accès selon une capacité de la structure EPST (voir services/roles.js). */
export function requirePermission(permission) {
  const allowed = PERMISSIONS[permission];
  if (!allowed) throw new Error(`Permission inconnue : ${permission}`);
  return requireRole(...allowed);
}
