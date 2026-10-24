import { z } from 'zod';
import { badRequest } from '../utils/httpError.js';
import { accessibleClassIds } from './access.js';
import { MAX_BATCH } from './attendance.js';

const twoDecimals = (v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6;

const recordSchema = z
  .object({
    id: z.uuid({ error: 'id doit être un UUID généré par l’appareil.' }),
    studentId: z.uuid({ error: 'studentId doit être un UUID.' }),
    subjectId: z.uuid({ error: 'subjectId doit être un UUID.' }),
    term: z.enum(['T1', 'T2', 'T3'], { error: 'term doit valoir T1, T2 ou T3.' }),
    evaluation: z.string().trim().min(1, 'evaluation est obligatoire.').max(60, 'evaluation trop longue.'),
    maxScore: z.number().positive('maxScore doit être > 0.').max(1000).refine(twoDecimals, '2 décimales maximum.'),
    score: z.number().min(0, 'score doit être ≥ 0.').max(1000).refine(twoDecimals, '2 décimales maximum.'),
    clientUpdatedAt: z
      .string()
      .refine((v) => !Number.isNaN(Date.parse(v)), 'clientUpdatedAt invalide (ISO 8601).')
      .optional(),
  })
  .refine((r) => r.score <= r.maxScore, { message: 'La note obtenue dépasse la note maximale.', path: ['score'] });

const toNumber = (d) => (d == null ? null : Number(d));
const isUniqueViolation = (e) => e?.code === 'P2002';

export function createGradesService({ prisma }) {
  async function upsertLastWriteWins(record, user, clientUpdatedAt) {
    const key = {
      studentId_subjectId_term_evaluation: {
        studentId: record.studentId,
        subjectId: record.subjectId,
        term: record.term,
        evaluation: record.evaluation,
      },
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await prisma.grade.findUnique({ where: key });
      if (!existing) {
        try {
          const row = await prisma.grade.create({
            data: {
              id: record.id,
              studentId: record.studentId,
              subjectId: record.subjectId,
              term: record.term,
              evaluation: record.evaluation,
              maxScore: record.maxScore,
              score: record.score,
              clientUpdatedAt,
              enteredById: user.id,
            },
          });
          return { row, outcome: 'created' };
        } catch (err) {
          if (isUniqueViolation(err) && attempt === 0) continue;
          throw err;
        }
      }
      if (clientUpdatedAt < existing.clientUpdatedAt) return { row: existing, outcome: 'stale' };
      if (Number(existing.score) === record.score && Number(existing.maxScore) === record.maxScore) {
        return { row: existing, outcome: 'unchanged' };
      }
      const row = await prisma.grade.update({
        where: { id: existing.id },
        data: {
          score: record.score,
          maxScore: record.maxScore,
          clientUpdatedAt,
          enteredById: user.id,
          version: { increment: 1 },
        },
      });
      return { row, outcome: 'updated' };
    }
    throw new Error('Impossible d’enregistrer la cote après relecture.');
  }

  return {
    async syncBatch(user, body) {
      const records = Array.isArray(body) ? body : body?.records;
      if (!Array.isArray(records)) throw badRequest('Le corps doit être un tableau JSON de cotes.');
      if (records.length === 0) throw badRequest('Le tableau des cotes est vide.');
      if (records.length > MAX_BATCH) throw badRequest(`Maximum ${MAX_BATCH} cotes par requête.`);

      const rejected = [];
      const candidates = [];
      records.forEach((raw, index) => {
        const parsed = recordSchema.safeParse(raw);
        if (parsed.success) candidates.push({ index, record: parsed.data });
        else
          rejected.push({
            index,
            id: typeof raw?.id === 'string' ? raw.id : null,
            result: 'rejected',
            errors: parsed.error.issues.map((i) => ({ field: i.path.join('.') || null, message: i.message })),
          });
      });

      const allowed = await accessibleClassIds(prisma, user);
      const [students, subjects] = await Promise.all([
        prisma.student.findMany({
          where: { id: { in: [...new Set(candidates.map((c) => c.record.studentId))] }, schoolId: user.schoolId, isActive: true },
          select: { id: true, classId: true },
        }),
        prisma.subject.findMany({
          where: { id: { in: [...new Set(candidates.map((c) => c.record.subjectId))] }, schoolId: user.schoolId },
          select: { id: true },
        }),
      ]);
      const studentById = new Map(students.map((s) => [s.id, s]));
      const subjectIds = new Set(subjects.map((s) => s.id));

      const valid = [];
      for (const c of candidates) {
        const student = studentById.get(c.record.studentId);
        const error = !student
          ? { field: 'studentId', message: 'Élève introuvable dans votre école.' }
          : !allowed.has(student.classId)
            ? { field: 'studentId', message: 'Cet élève n’appartient pas à vos classes.' }
            : !subjectIds.has(c.record.subjectId)
              ? { field: 'subjectId', message: 'Matière inconnue dans votre école.' }
              : null;
        if (error) rejected.push({ index: c.index, id: c.record.id, result: 'rejected', errors: [error] });
        else valid.push(c);
      }

      if (valid.length === 0) {
        throw badRequest('Aucune cote valide dans la requête.', rejected.sort((a, b) => a.index - b.index));
      }

      const results = [];
      for (const { index, record } of valid) {
        const clientUpdatedAt = record.clientUpdatedAt ? new Date(record.clientUpdatedAt) : new Date();
        const { row, outcome } = await upsertLastWriteWins(record, user, clientUpdatedAt);
        results.push({
          index,
          clientId: record.id,
          id: row.id,
          studentId: row.studentId,
          subjectId: row.subjectId,
          term: row.term,
          evaluation: row.evaluation,
          score: toNumber(row.score),
          maxScore: toNumber(row.maxScore),
          version: row.version,
          result: outcome,
        });
      }

      const all = [...results, ...rejected].sort((a, b) => a.index - b.index);
      return {
        summary: {
          received: records.length,
          saved: results.length,
          rejected: rejected.length,
          created: all.filter((r) => r.result === 'created').length,
          updated: all.filter((r) => r.result === 'updated').length,
          unchanged: all.filter((r) => r.result === 'unchanged').length,
          stale: all.filter((r) => r.result === 'stale').length,
        },
        results: all,
      };
    },
  };
}
