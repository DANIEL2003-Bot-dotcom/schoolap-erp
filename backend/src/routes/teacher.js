import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { z } from 'zod';
import { fromDbDate, toDbDate, todayIn } from '../utils/dates.js';
import { parseOrThrow } from '../utils/httpError.js';

const alertParams = z.object({ alertId: z.uuid({ error: 'Identifiant d’alerte invalide.' }) });

/**
 * GET /api/teacher/bootstrap
 * Tout ce dont l'application mobile a besoin pour fonctionner hors-ligne :
 * classes de l'enseignant, élèves, matières, appel du jour, cotes déjà synchronisés
 * et alertes de baisse des résultats en cours (les moyennes se calculent sur l'appareil, hors-ligne).
 */
export function teacherRouter({ prisma, config, performanceService }) {
  const router = Router();
  router.use(requireAuth({ prisma, config }), requirePermission('TAKE_ATTENDANCE'));

  router.get('/bootstrap', async (req, res) => {
    const user = req.user;
    const today = todayIn(config.timezone);
    const classWhere = user.role === 'TEACHER' ? { schoolId: user.schoolId, teacherId: user.id } : { schoolId: user.schoolId };

    const [school, classes, subjects] = await Promise.all([
      prisma.school.findUnique({ where: { id: user.schoolId } }),
      prisma.class.findMany({
        where: classWhere,
        orderBy: { name: 'asc' },
        include: {
          students: {
            where: { isActive: true },
            orderBy: [{ lastName: 'asc' }, { middleName: 'asc' }, { firstName: 'asc' }],
            select: { id: true, matricule: true, lastName: true, middleName: true, firstName: true, gender: true },
          },
        },
      }),
      prisma.subject.findMany({ where: { schoolId: user.schoolId }, orderBy: { name: 'asc' } }),
    ]);

    const classIds = classes.map((c) => c.id);
    const studentIds = classes.flatMap((c) => c.students.map((s) => s.id));
    const [attendance, grades, alerts] = await Promise.all([
      prisma.attendance.findMany({ where: { classId: { in: classIds }, date: toDbDate(today) } }),
      prisma.grade.findMany({ where: { studentId: { in: studentIds } } }),
      performanceService.listForUser(user),
    ]);

    res.json({
      success: true,
      serverDate: today,
      user: { id: user.id, fullName: user.fullName, role: user.role },
      school: { id: school.id, name: school.name, city: school.city, epstCode: school.epstCode },
      classes: classes.map((c) => ({
        id: c.id,
        name: c.name,
        level: c.level,
        option: c.option,
        students: c.students,
      })),
      subjects: subjects.map((s) => ({ id: s.id, name: s.name, defaultMaxScore: Number(s.defaultMaxScore) })),
      attendance: attendance.map((a) => ({
        id: a.id,
        studentId: a.studentId,
        classId: a.classId,
        date: fromDbDate(a.date),
        status: a.status,
        version: a.version,
        clientUpdatedAt: a.clientUpdatedAt.toISOString(),
      })),
      grades: grades.map((g) => ({
        id: g.id,
        studentId: g.studentId,
        subjectId: g.subjectId,
        term: g.term,
        evaluation: g.evaluation,
        maxScore: Number(g.maxScore),
        score: Number(g.score),
        version: g.version,
        clientUpdatedAt: g.clientUpdatedAt.toISOString(),
        createdAt: g.createdAt.toISOString(),
      })),
      alerts,
    });
  });

  /** Alertes de résultats des classes de l'enseignant (rafraîchissement sans tout recharger). */
  router.get('/alerts', async (req, res) => {
    res.json({ success: true, alerts: await performanceService.listForUser(req.user) });
  });

  /** « Élève suivi » : l'enseignant a pris l'élève en charge (remédiation, parent rencontré…). */
  router.post('/alerts/:alertId/acknowledge', async (req, res) => {
    const { alertId } = parseOrThrow(alertParams, req.params);
    const alert = await performanceService.acknowledge(req.user, alertId, req.body);
    res.json({ success: true, alert });
  });

  return router;
}
