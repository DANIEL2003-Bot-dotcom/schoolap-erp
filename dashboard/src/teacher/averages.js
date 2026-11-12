/* =============================================================================
   Moyennes et signaux de baisse — calcul sur l'appareil (fonctionne hors ligne)
   Mêmes règles que le serveur (backend/src/services/performance.js) ; la
   concordance des deux calculs est vérifiée par les tests du backend.
   - Moyenne = total des points obtenus / total des points possibles × 100
   - Signaux par matière (seuil 50 %) : deux échecs de suite ; moyenne du
     trimestre sous 50 % (au moins 2 cotes) ; dernière cote au moins 10 points
     sous la moyenne des cotes précédentes (au moins 2 cotes précédentes)
   - Moyenne générale : baisse d'au moins 10 points d'un trimestre à l'autre
     (au moins 3 cotes dans chacun des deux trimestres)
   ============================================================================= */

export const PASS_PCT = 50;
export const DROP_POINTS = 10;
export const MIN_TERM_GRADES = 2;
export const MIN_PREVIOUS_GRADES = 2;
export const MIN_GENERAL_TERM_GRADES = 3;
export const TERM_CODES = ['T1', 'T2', 'T3'];
export const SIGNAL_ORDER = ['ECHECS_CONSECUTIFS', 'FAIBLE', 'CHUTE'];
export const SIGNAL_LABELS = {
  ECHECS_CONSECUTIFS: 'Deux échecs de suite',
  FAIBLE: 'Moyenne sous 50 %',
  CHUTE: 'Baisse des résultats',
};
export const GENERAL_KEY = 'GENERAL';

const round1 = (v) => Math.round(v * 10) / 10;
const pctText = (v) => `${Math.round(v)} %`;

export const gradePct = (g) => (Number(g.score) / Number(g.maxScore)) * 100;

export function averagePct(grades) {
  let score = 0;
  let max = 0;
  for (const g of grades) {
    score += Number(g.score);
    max += Number(g.maxScore);
  }
  return max > 0 ? (score / max) * 100 : null;
}

export function chronological(grades) {
  return [...grades].sort(
    (a, b) =>
      TERM_CODES.indexOf(a.term) - TERM_CODES.indexOf(b.term) ||
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
      String(a.evaluation).localeCompare(String(b.evaluation), 'fr', { numeric: true }),
  );
}

/** Moyennes d'un élève : par trimestre (générale et par matière) et sur l'année. */
export function studentAverages(grades) {
  const terms = {};
  for (const term of TERM_CODES) {
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

/** Signaux de baisse d'un élève (voir l'en-tête). */
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
    });
  }

  const termsWithGrades = TERM_CODES.filter((t) => grades.filter((g) => g.term === t).length >= MIN_GENERAL_TERM_GRADES);
  const latestTerm = TERM_CODES.filter((t) => grades.some((g) => g.term === t)).pop();
  if (latestTerm && termsWithGrades.includes(latestTerm)) {
    const previous = termsWithGrades.filter((t) => TERM_CODES.indexOf(t) < TERM_CODES.indexOf(latestTerm)).pop();
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
        });
      }
    }
  }
  return found;
}

/**
 * Situation d'une classe : moyennes de chaque élève et élèves en difficulté.
 * Les signaux calculés sur l'appareil (y compris les cotes pas encore envoyées)
 * sont complétés par l'état des alertes du serveur (SMS au tuteur, prise en charge).
 */
export function classReport(cls, grades, subjects, serverAlerts = []) {
  const subjectNames = new Map(subjects.map((s) => [s.id, s.name]));
  const byStudent = new Map(cls.students.map((s) => [s.id, []]));
  for (const g of grades) byStudent.get(g.studentId)?.push(g);
  const alertsByKey = new Map(serverAlerts.map((a) => [`${a.studentId}:${a.subjectId ?? GENERAL_KEY}`, a]));

  const students = cls.students.map((student) => {
    const own = byStudent.get(student.id);
    const local = detectSignals(own, subjectNames).map((s) => {
      const server = alertsByKey.get(`${student.id}:${s.key}`);
      alertsByKey.delete(`${student.id}:${s.key}`);
      return { ...s, signals: SIGNAL_ORDER.filter((x) => s.signals.includes(x)), server: server ?? null };
    });
    // Alerte du serveur sans signal local (cotes saisies sur un autre appareil, pas encore rechargées)
    for (const [key, a] of alertsByKey) {
      if (!key.startsWith(`${student.id}:`)) continue;
      local.push({ key: a.subjectId ?? GENERAL_KEY, subjectId: a.subjectId, term: a.term, signals: a.signals, averagePct: a.averagePct, lastPct: a.lastPct, referencePct: a.referencePct, summary: a.summary, server: a });
      alertsByKey.delete(key);
    }
    return { student, averages: studentAverages(own), count: own.length, signals: local };
  });

  return {
    students,
    struggling: students.filter((s) => s.signals.length > 0),
    termsWithGrades: TERM_CODES.filter((t) => grades.some((g) => g.term === t)),
  };
}
