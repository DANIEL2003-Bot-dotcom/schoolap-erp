import { fromDbDate, schoolYearOf, toDbDate, zonedDayRange } from '../utils/dates.js';
import { studentFullName } from '../utils/names.js';

const round2 = (n) => Math.round(n * 100) / 100;

export function createDashboardService({ prisma, fees, timezone = 'Africa/Lubumbashi' }) {
  return {
    async summary(user, dateIso) {
      await fees.refreshStatuses();
      const date = toDbDate(dateIso);
      const schoolYear = schoolYearOf(dateIso);
      const dayRange = zonedDayRange(dateIso, timezone); // journée civile à Goma/Lubumbashi, pas en UTC
      const schoolId = user.schoolId;

      const [school, classes, groups, absents, feeTotals, insolvents, smsToday] = await Promise.all([
        prisma.school.findUnique({ where: { id: schoolId } }),
        prisma.class.findMany({
          where: { schoolId },
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            teacher: { select: { fullName: true } },
            _count: { select: { students: { where: { isActive: true } } } },
          },
        }),
        prisma.attendance.groupBy({
          by: ['classId', 'status'],
          where: { date, class: { schoolId } },
          _count: { _all: true },
        }),
        prisma.attendance.findMany({
          where: { date, status: 'ABSENT', class: { schoolId } },
          orderBy: [{ class: { name: 'asc' } }, { student: { lastName: 'asc' } }],
          select: {
            id: true,
            smsAlertSentAt: true,
            clientUpdatedAt: true,
            class: { select: { name: true } },
            student: { select: { id: true, matricule: true, lastName: true, middleName: true, firstName: true, guardianPhone: true } },
          },
        }),
        prisma.schoolFee.groupBy({
          by: ['currency'],
          // Taux de recouvrement sur les montants EXIGIBLES (échéance atteinte à la date consultée).
          where: { schoolYear, dueDate: { lte: date }, student: { schoolId, isActive: true } },
          _sum: { amountDue: true, amountPaid: true },
        }),
        prisma.schoolFee.findMany({
          where: { status: 'INSOLVABLE', student: { schoolId, isActive: true } },
          orderBy: [{ dueDate: 'asc' }, { student: { lastName: 'asc' } }],
          select: {
            id: true,
            label: true,
            feeType: true,
            amountDue: true,
            amountPaid: true,
            currency: true,
            dueDate: true,
            lastReminderAt: true,
            student: {
              select: {
                id: true,
                matricule: true,
                lastName: true,
                middleName: true,
                firstName: true,
                guardianPhone: true,
                class: { select: { name: true } },
              },
            },
          },
        }),
        prisma.smsLog.count({ where: { student: { schoolId }, createdAt: { gte: dayRange.start, lt: dayRange.end } } }),
      ]);

      const perClass = new Map(classes.map((c) => [c.id, { present: 0, absent: 0 }]));
      for (const g of groups) {
        const entry = perClass.get(g.classId);
        if (entry) entry[g.status === 'PRESENT' ? 'present' : 'absent'] = g._count._all;
      }
      const classRows = classes.map((c) => {
        const { present, absent } = perClass.get(c.id);
        return {
          id: c.id,
          name: c.name,
          teacher: c.teacher?.fullName ?? null,
          enrolled: c._count.students,
          present,
          absent,
          rollCallDone: present + absent > 0,
        };
      });

      const present = classRows.reduce((s, c) => s + c.present, 0);
      const absent = classRows.reduce((s, c) => s + c.absent, 0);
      const enrolled = classRows.reduce((s, c) => s + c.enrolled, 0);

      const finance = feeTotals.map((f) => {
        const due = Number(f._sum.amountDue ?? 0);
        const paid = Number(f._sum.amountPaid ?? 0);
        return { currency: f.currency, due: round2(due), paid: round2(paid), outstanding: round2(due - paid), recoveryRate: due > 0 ? paid / due : null };
      });

      return {
        date: dateIso,
        generatedAt: new Date().toISOString(),
        school: { name: school.name, city: school.city, province: school.province, epstCode: school.epstCode },
        schoolYear,
        attendance: {
          enrolled,
          present,
          absent,
          marked: present + absent,
          rate: present + absent > 0 ? present / (present + absent) : null,
          classesPending: classRows.filter((c) => !c.rollCallDone).map((c) => c.name),
          classes: classRows,
        },
        finance,
        smsSentToday: smsToday,
        absents: absents.map((a) => ({
          attendanceId: a.id,
          studentId: a.student.id,
          matricule: a.student.matricule,
          studentName: studentFullName(a.student),
          className: a.class.name,
          guardianPhone: a.student.guardianPhone,
          smsSent: Boolean(a.smsAlertSentAt),
          smsSentAt: a.smsAlertSentAt?.toISOString() ?? null,
        })),
        insolvents: insolvents.map((f) => ({
          feeId: f.id,
          studentId: f.student.id,
          matricule: f.student.matricule,
          studentName: studentFullName(f.student),
          className: f.student.class.name,
          guardianPhone: f.student.guardianPhone,
          label: f.label,
          feeType: f.feeType,
          amountDue: Number(f.amountDue),
          amountPaid: Number(f.amountPaid),
          remaining: round2(Number(f.amountDue) - Number(f.amountPaid)),
          currency: f.currency,
          dueDate: fromDbDate(f.dueDate),
          lastReminderAt: f.lastReminderAt?.toISOString() ?? null,
        })),
      };
    },
  };
}
