import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { fromDbDate, toDbDate, todayIn } from '../utils/dates.js';

/**
 * GET /api/teacher/bootstrap
 * Tout ce dont l'application mobile a besoin pour fonctionner hors-ligne :
 * classes de l'enseignant, élèves, matières, appel du jour et cotes déjà synchronisés.
 */
export function teacherRouter({ prisma, config }) {
  const router = Router();
  router.use(requireAuth({ prisma, config }), requireRole('TEACHER', 'DIRECTOR', 'ADMIN'));

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
    const [attendance, grades] = await Promise.all([
      prisma.attendance.findMany({ where: { classId: { in: classIds }, date: toDbDate(today) } }),
      prisma.grade.findMany({ where: { studentId: { in: studentIds } } }),
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
      })),
    });
  });

  return router;
}
