import { z } from 'zod';
import { badRequest } from '../utils/httpError.js';
import { daysBetween, formatDateFr, isValidIsoDate, toDbDate, fromDbDate, todayIn } from '../utils/dates.js';
import { studentFullName } from '../utils/names.js';
import { logger } from '../utils/logger.js';
import { accessibleClassIds } from './access.js';

export const MAX_BATCH = 500;
const MAX_PAST_DAYS = 60;

const recordSchema = z
  .object({
    id: z.uuid({ error: 'id doit être un UUID généré par l’appareil.' }),
    studentId: z.uuid({ error: 'studentId doit être un UUID.' }),
    date: z.string().refine(isValidIsoDate, 'date invalide (AAAA-MM-JJ).'),
    isPresent: z.boolean({ error: 'isPresent doit être un booléen.' }).optional(),
    status: z.enum(['PRESENT', 'ABSENT']).optional(),
    clientUpdatedAt: z
      .string()
      .refine((v) => !Number.isNaN(Date.parse(v)), 'clientUpdatedAt invalide (ISO 8601).')
      .optional(),
    // Champs envoyés par l'application mais IGNORÉS : le nom et le téléphone du tuteur
    // sont toujours relus en base (on n'envoie jamais un SMS à un numéro fourni par le client).
    studentName: z.string().max(200).optional(),
    parentPhone: z.string().max(40).optional(),
  })
  .refine((r) => r.isPresent !== undefined || r.status !== undefined, {
    message: 'isPresent (booléen) ou status (PRESENT/ABSENT) est obligatoire.',
    path: ['isPresent'],
  });

export function absenceMessage(student, isoDate) {
  return `Alerte École : Votre enfant ${studentFullName(student)} a été marqué ABSENT ce ${formatDateFr(isoDate)}.`;
}

const isUniqueViolation = (e) => e?.code === 'P2002';

export function createAttendanceService({ prisma, sms, config }) {
  /** Dernière écriture gagnante (selon l'horodatage de l'appareil) sur la clé (élève, date). */
  async function upsertLastWriteWins({ record, student, user, status, clientUpdatedAt }) {
    const key = { studentId_date: { studentId: student.id, date: toDbDate(record.date) } };
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await prisma.attendance.findUnique({ where: key });
      if (!existing) {
        try {
          const row = await prisma.attendance.create({
            data: {
              id: record.id,
              studentId: student.id,
              classId: student.classId,
              date: toDbDate(record.date),
              status,
              clientUpdatedAt,
              recordedById: user.id,
            },
          });
          return { row, outcome: 'created' };
        } catch (err) {
          if (isUniqueViolation(err) && attempt === 0) continue; // création concurrente : on relit
          throw err;
        }
      }
      if (clientUpdatedAt < existing.clientUpdatedAt) return { row: existing, outcome: 'stale' };
      if (existing.status === status) return { row: existing, outcome: 'unchanged' };
      const row = await prisma.attendance.update({
        where: { id: existing.id },
        data: { status, clientUpdatedAt, recordedById: user.id, version: { increment: 1 } },
      });
      if (existing.status === 'ABSENT' && existing.smsAlertSentAt) {
        logger.warn('Absence corrigée en présence après envoi du SMS', { attendanceId: row.id });
      }
      return { row, outcome: 'updated' };
    }
    throw new Error('Impossible d’enregistrer la présence après relecture.');
  }

  /** Envoie au plus UNE alerte par élève et par jour (réservation atomique avant envoi). */
  async function alertIfAbsent(row, student) {
    if (row.status !== 'ABSENT') return 'not_required';
    if (row.smsAlertSentAt) return 'already_sent';
    const claimed = await prisma.attendance.updateMany({
      where: { id: row.id, smsAlertSentAt: null, status: 'ABSENT' },
      data: { smsAlertSentAt: new Date() },
    });
    if (claimed.count === 0) return 'already_sent';
    try {
      await sms.send({
        studentId: student.id,
        phone: student.guardianPhone,
        message: absenceMessage(student, fromDbDate(row.date)),
        type: 'ABSENCE_ALERT',
        recipientLabel: `Tuteur de ${studentFullName(student)}`,
      });
      return 'sent';
    } catch (err) {
      await prisma.attendance.update({ where: { id: row.id }, data: { smsAlertSentAt: null } });
      logger.error('Échec de l’alerte SMS', { attendanceId: row.id, err: err.message });
      return 'failed';
    }
  }

  return {
    async syncBatch(user, body) {
      const records = Array.isArray(body) ? body : body?.records;
      if (!Array.isArray(records)) throw badRequest('Le corps doit être un tableau JSON de présences.');
      if (records.length === 0) throw badRequest('Le tableau des présences est vide.');
      if (records.length > MAX_BATCH) throw badRequest(`Maximum ${MAX_BATCH} présences par requête.`);

      const today = todayIn(config.timezone);
      const rejected = [];
      const candidates = [];

      records.forEach((raw, index) => {
        const parsed = recordSchema.safeParse(raw);
        if (!parsed.success) {
          rejected.push({
            index,
            id: typeof raw?.id === 'string' ? raw.id : null,
            result: 'rejected',
            errors: parsed.error.issues.map((i) => ({ field: i.path.join('.') || null, message: i.message })),
          });
          return;
        }
        const delta = daysBetween(parsed.data.date, today);
        if (delta < 0 || delta > MAX_PAST_DAYS) {
          rejected.push({
            index,
            id: parsed.data.id,
            result: 'rejected',
            errors: [{ field: 'date', message: delta < 0 ? 'Date future refusée.' : `Date de plus de ${MAX_PAST_DAYS} jours.` }],
          });
          return;
        }
        candidates.push({ index, record: parsed.data });
      });

      const allowed = await accessibleClassIds(prisma, user);
      const students = await prisma.student.findMany({
        where: { id: { in: [...new Set(candidates.map((c) => c.record.studentId))] }, schoolId: user.schoolId, isActive: true },
        select: { id: true, classId: true, lastName: true, middleName: true, firstName: true, guardianPhone: true },
      });
      const byId = new Map(students.map((s) => [s.id, s]));

      const valid = [];
      for (const c of candidates) {
        const student = byId.get(c.record.studentId);
        if (!student) {
          rejected.push({ index: c.index, id: c.record.id, result: 'rejected', errors: [{ field: 'studentId', message: 'Élève introuvable dans votre école.' }] });
        } else if (!allowed.has(student.classId)) {
          rejected.push({ index: c.index, id: c.record.id, result: 'rejected', errors: [{ field: 'studentId', message: 'Cet élève n’appartient pas à vos classes.' }] });
        } else {
          valid.push({ ...c, student });
        }
      }

      if (valid.length === 0) {
        throw badRequest('Aucune présence valide dans la requête.', rejected.sort((a, b) => a.index - b.index));
      }

      const results = [];
      for (const { index, record, student } of valid) {
        const status = record.status ?? (record.isPresent ? 'PRESENT' : 'ABSENT');
        const clientUpdatedAt = record.clientUpdatedAt ? new Date(record.clientUpdatedAt) : new Date();
        const { row, outcome } = await upsertLastWriteWins({ record, student, user, status, clientUpdatedAt });
        const smsStatus = await alertIfAbsent(row, student);
        results.push({
          index,
          clientId: record.id,
          id: row.id,
          studentId: student.id,
          date: fromDbDate(row.date),
          status: row.status,
          version: row.version,
          result: outcome,
          sms: smsStatus,
        });
      }

      const all = [...results, ...rejected].sort((a, b) => a.index - b.index);
      const count = (pred) => all.filter(pred).length;
      return {
        summary: {
          received: records.length,
          saved: results.length,
          rejected: rejected.length,
          created: count((r) => r.result === 'created'),
          updated: count((r) => r.result === 'updated'),
          unchanged: count((r) => r.result === 'unchanged'),
          stale: count((r) => r.result === 'stale'),
          smsSent: count((r) => r.sms === 'sent'),
        },
        results: all,
      };
    },
  };
}
