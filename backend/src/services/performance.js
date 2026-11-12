import { z } from 'zod';
import { badRequest, forbidden, notFound, parseOrThrow } from '../utils/httpError.js';
import { studentFullName } from '../utils/names.js';
import { logger } from '../utils/logger.js';
import { accessibleClassIds } from './access.js';

/* =============================================================================
   Suivi des résultats : moyennes et alertes de baisse
   - Moyenne = total des points obtenus / total des points possibles × 100
     (les examens, notés sur un maximum plus élevé, pèsent donc davantage : règle EPST)
   - 3 signaux, par élève et par matière (seuil de réussite : 50 %) :
       ECHECS_CONSECUTIFS : deux cotes de suite sous 50 %
       FAIBLE             : moyenne du trimestre en cours sous 50 % (au moins 2 cotes)
       CHUTE              : dernière cote au moins 10 points sous la moyenne des cotes précédentes
                            (au moins 2 cotes précédentes) ; pour la moyenne générale : baisse d'au
                            moins 10 points d'un trimestre à l'autre (au moins 3 cotes par trimestre)
   - Une alerte ouverte par élève et par matière ; fermée automatiquement quand plus aucun signal
     ne tient ; une nouvelle baisse rouvre une nouvelle alerte (et un nouveau SMS au tuteur)
   - SMS : un seul message par élève regroupant les matières, au plus un par 24 h
   ============================================================================= */

export const PASS_PCT = 50;
export const DROP_POINTS = 10;
export const MIN_TERM_GRADES = 2;
export const MIN_PREVIOUS_GRADES = 2;
export const MIN_GENERAL_TERM_GRADES = 3;
export const SMS_COOLDOWN_MS = 24 * 3_600_000;
export const TERMS = ['T1', 'T2', 'T3'];
export const TERM_LABELS = { T1: '1er trimestre', T2: '2e trimestre', T3: '3e trimestre' };
export const SIGNAL_ORDER = ['ECHECS_CONSECUTIFS', 'FAIBLE', 'CHUTE'];
export const SIGNAL_LABELS = {
  ECHECS_CONSECUTIFS: 'Deux échecs de suite',
  FAIBLE: 'Moyenne sous 50 %',
  CHUTE: 'Baisse des résultats',
};
const GENERAL_KEY = 'GENERAL';
const OPEN_STATUSES = ['ACTIVE', 'ACKNOWLEDGED'];

const round1 = (v) => Math.round(v * 10) / 10;
const pctText = (v) => `${Math.round(v)} %`;
const num = (v) => (v == null ? null : Number(v));

/** Pourcentage d'une cote. */
export const gradePct = (g) => (Number(g.score) / Number(g.maxScore)) * 100;

/** Moyenne pondérée par les points (null si aucune cote). */
export function averagePct(grades) {
  let score = 0;
  let max = 0;
  for (const g of grades) {
    score += Number(g.score);
    max += Number(g.maxScore);
  }
  return max > 0 ? (score / max) * 100 : null;
}

/** Ordre chronologique : trimestre, puis date de première saisie, puis nom de l'évaluation. */
export function chronological(grades) {
  return [...grades].sort(
    (a, b) =>
      TERMS.indexOf(a.term) - TERMS.indexOf(b.term) ||
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
      String(a.evaluation).localeCompare(String(b.evaluation), 'fr', { numeric: true }),
  );
}

/**
 * Moyennes d'un élève : par trimestre (générale et par matière) et sur l'année.
 * @returns {{ terms: Record<string,{ general:number|null, subjects:Record<string,number>, count:number }>, year:{ general:number|null, subjects:Record<string,number> } }}
 */
export function studentAverages(grades) {
  const terms = {};
  for (const term of TERMS) {
    const inTerm = grades.filter((g) => g.term === term);
    if (!inTerm.length) continue;
    const subjects = {};
    for (const subjectId of new Set(inTerm.map((g) => g.subjectId))) subjects[subjectId] = round1(averagePct(inTerm.filter((g) => g.subjectId === subjectId)));
    terms[term] = { general: round1(averagePct(inTerm)), subjects, count: inTerm.length };
  }
  const yearSubjects = {};
  for (const subjectId of new Set(grades.map((g) => g.subjectId))) yearSubjects[subjectId] = round1(averagePct(grades.filter((g) => g.subjectId === subjectId)));
  const general = averagePct(grades);
  return { terms, year: { general: general == null ? null : round1(general), subjects: yearSubjects } };
}

/**
 * Détecte les signaux de baisse d'un élève.
 * @param grades cotes de l'élève ({ subjectId, term, evaluation, score, maxScore, createdAt })
 * @param subjectNames Map subjectId → nom de la matière
 * @returns {Array<{ key, subjectId, term, signals, averagePct, lastPct, referencePct, summary, smsPart }>}
 */
export function detectSignals(grades, subjectNames = new Map()) {
  const found = [];
  const bySubject = new Map();
  for (const g of chronological(grades)) {
    if (!bySubject.has(g.subjectId)) bySubject.set(g.subjectId, []);
    bySubject.get(g.subjectId).push(g);
  }

  for (const [subjectId, list] of bySubject) {
    const name = subjectNames.get(subjectId) ?? 'Matière';
    const term = list[list.length - 1].term;
    const signals = [];
    const reasons = [];
    const inTerm = list.filter((g) => g.term === term);
    const termAvg = averagePct(inTerm);
    const last = gradePct(list[list.length - 1]);
    let reference = null;

    if (list.length >= 2) {
      const before = gradePct(list[list.length - 2]);
      if (before < PASS_PCT && last < PASS_PCT) {
        signals.push('ECHECS_CONSECUTIFS');
        reasons.push(`deux échecs de suite (${pctText(before)} puis ${pctText(last)})`);
      }
    }
    if (inTerm.length >= MIN_TERM_GRADES && termAvg < PASS_PCT) {
      signals.push('FAIBLE');
      reasons.push(`moyenne ${term} ${pctText(termAvg)} (sous 50 %)`);
    }
    if (list.length >= MIN_PREVIOUS_GRADES + 1) {
      reference = averagePct(list.slice(0, -1));
      if (last <= reference - DROP_POINTS) {
        signals.push('CHUTE');
        reasons.push(`baisse de ${Math.round(reference - last)} points (${pctText(last)} contre ${pctText(reference)} avant)`);
      }
    }
    if (!signals.length) continue;
    found.push({
      key: subjectId,
      subjectId,
      term,
      signals,
      averagePct: termAvg == null ? null : round1(termAvg),
      lastPct: round1(last),
      referencePct: reference == null ? null : round1(reference),
      summary: `${name} : ${reasons.join(' · ')}`,
      // Baisse seule : la moyenne peut rester correcte, le SMS cite donc la dernière cote.
      smsPart:
        signals.length === 1 && signals[0] === 'CHUTE'
          ? `${name} : dernière cote ${pctText(last)}`
          : `${name} ${pctText(inTerm.length >= MIN_TERM_GRADES ? termAvg : last)}`,
    });
  }

  // Moyenne générale : comparaison du dernier trimestre avec le précédent
  const termsWithGrades = TERMS.filter((t) => grades.filter((g) => g.term === t).length >= MIN_GENERAL_TERM_GRADES);
  const latestTerm = TERMS.filter((t) => grades.some((g) => g.term === t)).pop();
  if (latestTerm && termsWithGrades.includes(latestTerm)) {
    const previous = termsWithGrades.filter((t) => TERMS.indexOf(t) < TERMS.indexOf(latestTerm)).pop();
    if (previous) {
      const current = averagePct(grades.filter((g) => g.term === latestTerm));
      const before = averagePct(grades.filter((g) => g.term === previous));
      if (current <= before - DROP_POINTS) {
        found.push({
          key: GENERAL_KEY,
          subjectId: null,
          term: latestTerm,
          signals: ['CHUTE'],
          averagePct: round1(current),
          lastPct: null,
          referencePct: round1(before),
          summary: `Moyenne générale en baisse : ${pctText(current)} au ${latestTerm} contre ${pctText(before)} au ${previous}`,
          smsPart: `moyenne générale ${pctText(current)}`,
        });
      }
    }
  }
  return found;
}

/** Texte du SMS au tuteur (une seule fois par baisse), raccourci pour tenir en 1 SMS si possible. */
export function buildParentSms(schoolName, student, parts) {
  const name = [student.firstName, student.lastName?.toUpperCase()].filter(Boolean).join(' ');
  const make = (list) => `${schoolName}: les résultats de ${name} baissent (${list}). Merci de rencontrer son titulaire pour l'aider avant la fin de l'année.`;
  for (let n = parts.length; n >= 1; n--) {
    const list = parts.slice(0, n).join(', ') + (n < parts.length ? ` +${parts.length - n}` : '');
    const text = make(list);
    if (text.length <= 160 || n === 1) return text;
  }
  return make(parts[0]);
}

const keyOf = (alert) => alert.subjectId ?? GENERAL_KEY;
const sameValues = (a, b) =>
  a.term === b.term &&
  a.summary === b.summary &&
  a.signals.join() === b.signals.join() &&
  num(a.averagePct) === b.averagePct &&
  num(a.lastPct) === b.lastPct &&
  num(a.referencePct) === b.referencePct;

const ackSchema = z.object({ note: z.string().trim().max(300, 'Note trop longue (300 caractères maximum).').optional() });

export function createPerformanceService({ prisma, sms }) {
  const include = {
    student: { select: { id: true, matricule: true, lastName: true, middleName: true, firstName: true, classId: true, class: { select: { id: true, name: true } } } },
    subject: { select: { id: true, name: true } },
    acknowledgedBy: { select: { id: true, fullName: true } },
  };

  function serialize(a) {
    const sorted = SIGNAL_ORDER.filter((s) => a.signals.includes(s));
    return {
      id: a.id,
      studentId: a.studentId,
      studentName: studentFullName(a.student),
      matricule: a.student.matricule,
      classId: a.student.classId,
      className: a.student.class?.name ?? null,
      subjectId: a.subjectId,
      subjectName: a.subject?.name ?? null,
      scope: a.subjectId ? 'SUBJECT' : 'GENERAL',
      term: a.term,
      signals: sorted,
      signalLabels: sorted.map((s) => SIGNAL_LABELS[s]),
      status: a.status,
      averagePct: num(a.averagePct),
      lastPct: num(a.lastPct),
      referencePct: num(a.referencePct),
      summary: a.summary,
      smsStatus: a.smsStatus,
      smsSentAt: a.smsSentAt?.toISOString() ?? null,
      acknowledgedBy: a.acknowledgedBy?.fullName ?? null,
      acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null,
      note: a.note,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    };
  }

  /** Alertes ouvertes, les plus récentes d'abord (ACTIVE avant ACKNOWLEDGED). */
  async function openAlerts(where, take) {
    const rows = await prisma.performanceAlert.findMany({
      where: { ...where, status: { in: OPEN_STATUSES } },
      include,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      ...(take ? { take } : {}),
    });
    return rows.map(serialize);
  }

  async function sendParentSms(school, student, created) {
    const recent = await prisma.smsLog.findFirst({
      where: { studentId: student.id, type: 'PERFORMANCE_ALERT', createdAt: { gte: new Date(Date.now() - SMS_COOLDOWN_MS) } },
      select: { id: true },
    });
    if (recent) return { status: 'SKIPPED_RECENT', at: null };
    const message = buildParentSms(school.name, student, created.map((c) => c.smsPart));
    const res = await sms.send({ studentId: student.id, phone: student.guardianPhone, message, type: 'PERFORMANCE_ALERT' });
    return { status: 'SENT', at: res.sentAt };
  }

  return {
    serialize,

    /**
     * Recalcule les alertes des élèves donnés (après une saisie de cotes).
     * Ouvre les nouvelles baisses, met à jour les alertes en cours, ferme celles qui ne tiennent plus.
     */
    async evaluateStudents(studentIds, { notifyParents = true } = {}) {
      const ids = [...new Set(studentIds)];
      if (!ids.length) return { opened: 0, updated: 0, resolved: 0, smsSent: 0, alerts: [] };
      const students = await prisma.student.findMany({
        where: { id: { in: ids } },
        select: { id: true, schoolId: true, lastName: true, middleName: true, firstName: true, guardianPhone: true, isActive: true, school: { select: { name: true } } },
      });
      const [grades, existing] = await Promise.all([
        prisma.grade.findMany({
          where: { studentId: { in: ids } },
          select: { studentId: true, subjectId: true, term: true, evaluation: true, score: true, maxScore: true, createdAt: true },
        }),
        prisma.performanceAlert.findMany({ where: { studentId: { in: ids }, status: { in: OPEN_STATUSES } } }),
      ]);
      const subjects = await prisma.subject.findMany({ where: { id: { in: [...new Set(grades.map((g) => g.subjectId))] } }, select: { id: true, name: true } });
      const subjectNames = new Map(subjects.map((s) => [s.id, s.name]));

      const stats = { opened: 0, updated: 0, resolved: 0, smsSent: 0, alerts: [] };
      for (const student of students) {
        const signals = student.isActive ? detectSignals(grades.filter((g) => g.studentId === student.id), subjectNames) : [];
        const open = new Map(existing.filter((a) => a.studentId === student.id).map((a) => [keyOf(a), a]));
        const created = [];

        for (const s of signals) {
          const current = open.get(s.key);
          const data = { term: s.term, signals: s.signals, averagePct: s.averagePct, lastPct: s.lastPct, referencePct: s.referencePct, summary: s.summary };
          if (current) {
            open.delete(s.key);
            if (!sameValues(current, s)) {
              await prisma.performanceAlert.update({ where: { id: current.id }, data });
              stats.updated++;
            }
            continue;
          }
          try {
            const row = await prisma.performanceAlert.create({ data: { ...data, schoolId: student.schoolId, studentId: student.id, subjectId: s.subjectId } });
            created.push({ ...s, id: row.id });
            stats.opened++;
          } catch (err) {
            // Une saisie simultanée a déjà ouvert la même alerte (index unique partiel) : rien à faire.
            if (!(err?.code === 'P2002' || /performance_alerts_open_key/.test(String(err?.message)))) throw err;
          }
        }

        for (const stale of open.values()) {
          await prisma.performanceAlert.update({ where: { id: stale.id }, data: { status: 'RESOLVED', resolvedAt: new Date() } });
          stats.resolved++;
        }

        if (created.length && notifyParents && student.guardianPhone) {
          try {
            const { status, at } = await sendParentSms(student.school, student, created);
            await prisma.performanceAlert.updateMany({ where: { id: { in: created.map((c) => c.id) } }, data: { smsStatus: status, smsSentAt: at } });
            if (status === 'SENT') stats.smsSent++;
          } catch (err) {
            logger.error('SMS d’alerte de résultats non envoyé', { studentId: student.id, error: err.message });
          }
        }
        if (created.length) {
          const rows = await prisma.performanceAlert.findMany({ where: { id: { in: created.map((c) => c.id) } }, include });
          stats.alerts.push(...rows.map(serialize));
        }
      }
      return stats;
    },

    /** Alertes ouvertes visibles par l'utilisateur (enseignant : ses classes ; direction : toute l'école). */
    async listForUser(user, { take } = {}) {
      const classIds = [...(await accessibleClassIds(prisma, user))];
      return openAlerts({ schoolId: user.schoolId, student: { classId: { in: classIds }, isActive: true } }, take);
    },

    /** Synthèse pour le tableau de bord de la direction. */
    async schoolOverview(user, take = 60) {
      const where = { schoolId: user.schoolId, status: { in: OPEN_STATUSES }, student: { isActive: true } };
      const [alerts, grouped] = await Promise.all([
        openAlerts({ schoolId: user.schoolId, student: { isActive: true } }, take),
        prisma.performanceAlert.groupBy({ by: ['studentId', 'status'], where, _count: { _all: true } }),
      ]);
      const students = new Set(grouped.map((g) => g.studentId));
      const pendingStudents = new Set(grouped.filter((g) => g.status === 'ACTIVE').map((g) => g.studentId));
      return {
        openCount: grouped.reduce((s, g) => s + g._count._all, 0),
        studentsCount: students.size,
        pendingStudents: pendingStudents.size,
        alerts,
      };
    },

    /** Moyennes et alertes d'un élève (fiche élève du tableau de bord). */
    async studentPerformance(studentId) {
      const [grades, alerts] = await Promise.all([
        prisma.grade.findMany({ where: { studentId }, include: { subject: { select: { id: true, name: true } } } }),
        openAlerts({ studentId }),
      ]);
      const averages = studentAverages(grades);
      const subjects = [...new Map(grades.map((g) => [g.subjectId, g.subject.name])).entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
      return { passMark: PASS_PCT, subjects, averages, alerts };
    },

    /** « Marquer comme suivi » : l'élève a été recadré, le parent rencontré… */
    async acknowledge(user, alertId, body) {
      const { note } = parseOrThrow(ackSchema, body ?? {});
      const alert = await prisma.performanceAlert.findFirst({ where: { id: alertId, schoolId: user.schoolId }, include: { student: { select: { classId: true } } } });
      if (!alert) throw notFound('Alerte introuvable.');
      const classes = await accessibleClassIds(prisma, user);
      if (!classes.has(alert.student.classId)) throw forbidden('Cet élève n’appartient pas à vos classes.');
      if (alert.status === 'RESOLVED') throw badRequest('Cette alerte est déjà close : les résultats de l’élève sont remontés.');
      const row = await prisma.performanceAlert.update({
        where: { id: alert.id },
        data: { status: 'ACKNOWLEDGED', acknowledgedById: user.id, acknowledgedAt: new Date(), note: note || null },
        include,
      });
      return serialize(row);
    },
  };
}
