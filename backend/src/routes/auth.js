import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { requireAuth, signToken } from '../middleware/auth.js';
import { PERMISSIONS, ROLES } from '../services/roles.js';
import { parseOrThrow, unauthorized } from '../utils/httpError.js';
import { normalizeDrcPhone } from '../utils/phone.js';

const loginSchema = z.object({
  phone: z.string({ error: 'phone est obligatoire.' }).min(9).max(20),
  password: z.string({ error: 'password est obligatoire.' }).min(4).max(128),
});

/** Profil renvoyé au client : rôle, libellé EPST, bureau et capacités (pour adapter l'interface). */
function profile(user, office) {
  return {
    id: user.id,
    fullName: user.fullName,
    phone: user.phone,
    role: user.role,
    roleLabel: ROLES[user.role]?.label ?? user.role,
    office: office ? { id: office.id, code: office.code, name: office.name } : null,
    permissions: Object.keys(PERMISSIONS).filter((p) => PERMISSIONS[p].includes(user.role)),
  };
}

// Hash factice : le temps de réponse est identique que le compte existe ou non.
const DUMMY_HASH = bcrypt.hashSync('compte-inexistant', 10);

export function authRouter({ prisma, config }) {
  const router = Router();
  const loginLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: config.isTest ? 1000 : 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) =>
      res.status(429).json({ success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Trop de tentatives. Réessayez dans 15 minutes.' } }),
  });

  router.post('/login', loginLimiter, async (req, res) => {
    const { phone, password } = parseOrThrow(loginSchema, req.body, 'Identifiants invalides.');
    const e164 = normalizeDrcPhone(phone);
    const user = e164 ? await prisma.user.findUnique({ where: { phone: e164 }, include: { school: true, office: true } }) : null;
    const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok || !user.isActive) throw unauthorized('Téléphone ou mot de passe incorrect.');

    res.json({
      success: true,
      token: signToken(user, config),
      user: profile(user, user.office),
      school: { id: user.school.id, name: user.school.name, city: user.school.city, epstCode: user.school.epstCode },
    });
  });

  /** Vérification de session : le tableau de bord l'appelle au démarrage avant d'afficher quoi que ce soit. */
  router.get('/me', requireAuth({ prisma, config }), async (req, res) => {
    const [school, office] = await Promise.all([
      prisma.school.findUnique({ where: { id: req.user.schoolId } }),
      req.user.officeId ? prisma.office.findUnique({ where: { id: req.user.officeId } }) : null,
    ]);
    res.json({
      success: true,
      user: { ...profile(req.user, office), schoolId: req.user.schoolId, isActive: req.user.isActive },
      school: { id: school.id, name: school.name, city: school.city, epstCode: school.epstCode },
    });
  });

  return router;
}
