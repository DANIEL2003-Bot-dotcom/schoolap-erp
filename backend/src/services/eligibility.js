import { z } from 'zod';
import { parseOrThrow } from '../utils/httpError.js';
import { schoolYearOf, toDbDate, todayIn } from '../utils/dates.js';
import { studentFullName } from '../utils/names.js';

/* =============================================================================
   « En ordre » avec les frais scolaires : autorisation de suivre les cours
   - Seuls le Comptable et l'Administrateur voient les montants (droit VIEW_AMOUNTS).
   - Tous les autres (Directeur, Préfet, D.E., D.D., enseignants) ne voient que des
     pourcentages et le statut « En ordre / Pas en ordre ».
   Règle : l'élève est en ordre s'il a payé au moins le seuil de l'école
   (School.eligibilityThreshold, 50 % par défaut) de ses frais EXIGIBLES de l'année
   (échéance atteinte). Sans frais exigible, il est en ordre.
   Si l'élève a des frais en plusieurs devises, on retient la devise la moins
   payée : 100 % en USD ne compense pas 0 % en CDF.
   ============================================================================= */

export const DEFAULT_ELIGIBILITY_THRESHOLD = 50;

const settingsSchema = z.object({
  eligibilityThreshold: z
    .number({ error: 'Le seuil doit être un nombre entier entre 0 et 100.' })
    .int('Le seuil doit être un nombre entier entre 0 et 100.')
    .min(0, 'Le seuil doit être compris entre 0 et 100 %.')
    .max(100, 'Le seuil doit être compris entre 0 et 100 %.'),
});

/** Taux payé (0 à 1) à partir des sommes par devise, ou null sans frais exigible. */
export function paidRateOf(perCurrency) {
  const rates = [...perCurrency.values()].filter((c) => c.due > 0).map((c) => Math.min(1, c.paid / c.due));
  return rates.length ? Math.min(...rates) : null;
}

/** Décision « en ordre » : sans frais exigible → en ordre ; sinon taux payé ≥ seuil. Tolérance d'arrondi au centime. */
export function isEligible(paidRate, threshold) {
  return paidRate === null || paidRate * 100 + 1e-9 >= threshold;
}

const percent = (rate) => (rate === null ? null : Math.round(rate * 1000) / 10);

export function createEligibilityService({ prisma, config }) {
  const today = () => todayIn(config.timezone);

  async function thresholdOf(schoolId) {
    const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { eligibilityThreshold: true } });
    return school?.eligibilityThreshold ?? DEFAULT_ELIGIBILITY_THRESHOLD;
  }

  /**
   * Statut de chaque élève demandé : Map studentId → { eligible, paidRate (0..1|null), paidPercent, exigibleFees }.
   * `studentIds` absent = tous les élèves actifs de l'école.
   */
  async function forStudents(schoolId, { studentIds = null, dateIso = today(), threshold = null } = {}) {
    const limit = threshold ?? (await thresholdOf(schoolId));
    const studentWhere = studentIds ? { id: { in: studentIds }, schoolId } : { schoolId, isActive: true };
    const [students, groups] = await Promise.all([
      prisma.student.findMany({ where: studentWhere, select: { id: true } }),
      prisma.schoolFee.groupBy({
        by: ['studentId', 'currency'],
        where: { schoolYear: schoolYearOf(dateIso), dueDate: { lte: toDbDate(dateIso) }, student: studentWhere },
        _sum: { amountDue: true, amountPaid: true },
        _count: { _all: true },
      }),
    ]);
    const sums = new Map();
    for (const g of groups) {
      const perCurrency = sums.get(g.studentId) ?? { currencies: new Map(), count: 0 };
      perCurrency.currencies.set(g.currency, { due: Number(g._sum.amountDue ?? 0), paid: Number(g._sum.amountPaid ?? 0) });
      perCurrency.count += g._count._all;
      sums.set(g.studentId, perCurrency);
    }
    const out = new Map();
    for (const s of students) {
      const entry = sums.get(s.id);
      const rate = entry ? paidRateOf(entry.currencies) : null;
      out.set(s.id, { eligible: isEligible(rate, limit), paidRate: rate, paidPercent: percent(rate), exigibleFees: entry?.count ?? 0 });
    }
    return { threshold: limit, statuses: out };
  }

  return {
    thresholdOf,
    forStudents,

    /** Statut d'un seul élève (fiche élève). */
    async forStudent(schoolId, studentId, dateIso = today()) {
      const { threshold, statuses } = await forStudents(schoolId, { studentIds: [studentId], dateIso });
      return { threshold, ...(statuses.get(studentId) ?? { eligible: true, paidRate: null, paidPercent: null, exigibleFees: 0 }) };
    },

    /**
     * Synthèse école pour le tableau de bord : effectifs en ordre / pas en ordre, par classe,
     * et liste nominative des élèves pas en ordre — sans aucun montant.
     */
    async schoolOverview(user, dateIso = today()) {
      const schoolId = user.schoolId;
      const [{ threshold, statuses }, students] = await Promise.all([
        forStudents(schoolId, { dateIso }),
        prisma.student.findMany({
          where: { schoolId, isActive: true },
          orderBy: [{ class: { name: 'asc' } }, { lastName: 'asc' }, { middleName: 'asc' }, { firstName: 'asc' }],
          select: {
            id: true,
            matricule: true,
            lastName: true,
            middleName: true,
            firstName: true,
            classId: true,
            class: { select: { name: true } },
          },
        }),
      ]);
      const byClass = new Map();
      const notEligible = [];
      for (const s of students) {
        const st = statuses.get(s.id);
        const row = byClass.get(s.classId) ?? { classId: s.classId, className: s.class.name, enrolled: 0, eligible: 0, notEligible: 0, rateSum: 0, rated: 0 };
        row.enrolled += 1;
        if (st.eligible) row.eligible += 1;
        else row.notEligible += 1;
        if (st.paidRate !== null) {
          row.rateSum += st.paidRate;
          row.rated += 1;
        }
        byClass.set(s.classId, row);
        if (!st.eligible) {
          notEligible.push({
            studentId: s.id,
            matricule: s.matricule,
            studentName: studentFullName(s),
            classId: s.classId,
            className: s.class.name,
            paidPercent: st.paidPercent,
          });
        }
      }
      const classes = [...byClass.values()].map(({ rateSum, rated, ...c }) => ({ ...c, averagePaidPercent: rated ? percent(rateSum / rated) : null }));
      const eligibleCount = classes.reduce((n, c) => n + c.eligible, 0);
      return {
        threshold,
        date: dateIso,
        totalStudents: students.length,
        eligibleCount,
        notEligibleCount: students.length - eligibleCount,
        eligibleRate: students.length ? eligibleCount / students.length : null,
        classes,
        notEligible,
      };
    },

    /** Réglage du seuil (Administrateur). */
    async updateSettings(user, body) {
      const input = parseOrThrow(settingsSchema, body, 'Réglage invalide.');
      const school = await prisma.school.update({
        where: { id: user.schoolId },
        data: { eligibilityThreshold: input.eligibilityThreshold },
        select: { eligibilityThreshold: true },
      });
      return { settings: { eligibilityThreshold: school.eligibilityThreshold } };
    },
  };
}
