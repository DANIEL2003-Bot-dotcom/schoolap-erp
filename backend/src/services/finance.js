import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { badRequest, conflict, notFound, parseOrThrow } from '../utils/httpError.js';
import { daysBetween, fromDbDate, isValidIsoDate, schoolYearOf, todayIn, zonedDayRange } from '../utils/dates.js';
import { detectOperator, formatPhone, normalizeDrcPhone } from '../utils/phone.js';
import { studentFullName } from '../utils/names.js';
import { amountToWordsFr } from '../utils/amountWords.js';
import { logger } from '../utils/logger.js';
import { computeFeeStatus, formatMoney } from './fees.js';
import { ROLES } from './roles.js';

/* =============================================================================
   Caisse de l'école (bureau Comptabilité)
   - Encaissement manuel : espèces, dépôt bancaire (bordereau), Mobile Money reçu
     directement sur le téléphone de l'école.
   - Reçu numéroté sans trou par école et par année scolaire (000001/2026-2027),
     montant en toutes lettres, reste à payer au moment du paiement.
   - Impression : la première est l'original, les suivantes portent « DUPLICATA ».
   - Journal de caisse par jour ou par période, totaux par devise, mode et caissier.
   - Annulation d'un reçu : réservée à la direction, motif obligatoire, montant
     retiré du frais, tuteur prévenu par SMS. Un reçu n'est jamais supprimé.
   ============================================================================= */

export const PAYMENT_METHODS = Object.freeze({
  CASH: { label: 'Espèces', short: 'Espèces' },
  BANK: { label: 'Dépôt bancaire', short: 'Banque' },
  MOBILE_MONEY_DIRECT: { label: 'Mobile Money (téléphone de l’école)', short: 'Mobile Money' },
  MOBILE_MONEY: { label: 'Mobile Money (demande en ligne)', short: 'Mobile Money en ligne' },
});

export const OPERATOR_NAMES = Object.freeze({ MPESA: 'M-Pesa', ORANGE_MONEY: 'Orange Money', AIRTEL_MONEY: 'Airtel Money' });

/** Durée maximale d'une période du journal de caisse. */
export const MAX_JOURNAL_DAYS = 31;

const twoDecimals = (v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6;
const round2 = (n) => Math.round(n * 100) / 100;
const isUniqueViolation = (e) => e?.code === 'P2002';

const optionalText = (max, label) =>
  z
    .string()
    .trim()
    .max(max, `${label} : ${max} caractères maximum.`)
    .nullish()
    .transform((v) => (v ? v : null));

const recordSchema = z
  .object({
    clientRequestId: z.uuid({ error: 'clientRequestId doit être un UUID.' }),
    schoolFeeId: z.uuid({ error: 'Frais invalide.' }),
    amount: z
      .number({ error: 'Le montant doit être un nombre.' })
      .positive('Le montant doit être supérieur à 0.')
      .max(1_000_000_000, 'Montant trop élevé.')
      .refine(twoDecimals, '2 décimales maximum.'),
    method: z.enum(['CASH', 'BANK', 'MOBILE_MONEY_DIRECT'], { error: 'Mode de paiement : CASH, BANK ou MOBILE_MONEY_DIRECT.' }),
    payerName: optionalText(120, 'Nom du déposant'),
    payerPhone: optionalText(20, 'Téléphone'),
    operator: z.enum(['MPESA', 'ORANGE_MONEY', 'AIRTEL_MONEY'], { error: 'Opérateur : MPESA, ORANGE_MONEY ou AIRTEL_MONEY.' }).nullish(),
    externalRef: optionalText(64, 'Référence'),
    bankName: optionalText(80, 'Banque'),
    note: optionalText(300, 'Remarque'),
  })
  .superRefine((b, ctx) => {
    if (b.method === 'BANK') {
      if (!b.bankName) ctx.addIssue({ code: 'custom', path: ['bankName'], message: 'Indiquez la banque.' });
      if (!b.externalRef) ctx.addIssue({ code: 'custom', path: ['externalRef'], message: 'Indiquez le numéro du bordereau de versement.' });
    }
    if (b.method === 'MOBILE_MONEY_DIRECT') {
      if (!b.operator) ctx.addIssue({ code: 'custom', path: ['operator'], message: 'Choisissez l’opérateur Mobile Money.' });
      if (!b.externalRef) ctx.addIssue({ code: 'custom', path: ['externalRef'], message: 'Indiquez la référence de la transaction reçue par SMS.' });
    }
  });

const cancelSchema = z.object({
  reason: z
    .string({ error: 'Le motif d’annulation est obligatoire.' })
    .trim()
    .min(5, 'Motif d’annulation : 5 caractères minimum.')
    .max(300, 'Motif d’annulation : 300 caractères maximum.'),
});

const journalSchema = z.object({
  from: z.string().refine(isValidIsoDate, 'Date de début invalide (AAAA-MM-JJ).').optional(),
  to: z.string().refine(isValidIsoDate, 'Date de fin invalide (AAAA-MM-JJ).').optional(),
  method: z.enum(['CASH', 'BANK', 'MOBILE_MONEY_DIRECT', 'MOBILE_MONEY']).optional(),
});

/** Format du numéro de reçu : 000012/2026-2027. */
export const formatReceiptNumber = (n, schoolYear) => `${String(n).padStart(6, '0')}/${schoolYear}`;

/**
 * Attribue le prochain numéro de reçu de l'école pour l'année scolaire, de façon atomique
 * (INSERT … ON CONFLICT … RETURNING) : deux caisses simultanées n'obtiennent jamais le même numéro.
 * À appeler dans la même transaction SQL que l'enregistrement du paiement (pas de trou si elle échoue).
 */
export async function allocateReceiptNumber(db, schoolId, schoolYear) {
  const rows = await db.$queryRaw`
    INSERT INTO receipt_counters (school_id, school_year, last_number, updated_at)
    VALUES (${schoolId}::uuid, ${schoolYear}, 1, now())
    ON CONFLICT (school_id, school_year)
    DO UPDATE SET last_number = receipt_counters.last_number + 1, updated_at = now()
    RETURNING last_number`;
  return formatReceiptNumber(rows[0].last_number, schoolYear);
}

export function newTransactionId(todayIso) {
  return `TX-${todayIso.replaceAll('-', '')}-${randomBytes(4).toString('hex').toUpperCase()}`;
}

/** Libellé du mode de paiement avec ses détails (imprimé sur le reçu et dans le journal). */
export function methodDetails(t) {
  if (t.method === 'CASH') return 'Espèces';
  if (t.method === 'BANK') return `Dépôt bancaire · ${t.bankName ?? '—'} · bordereau n° ${t.externalRef ?? '—'}`;
  const op = OPERATOR_NAMES[t.operator] ?? 'Mobile Money';
  if (t.method === 'MOBILE_MONEY_DIRECT') return `${op} (téléphone de l’école) · réf. ${t.externalRef ?? '—'}`;
  return `${op} · réf. ${t.reference ?? t.transactionId}`;
}

/** Libellé court pour le SMS au tuteur (alphabet GSM : pas d'apostrophe typographique). */
function methodForSms(t) {
  if (t.method === 'CASH') return 'en especes';
  if (t.method === 'BANK') return `par depot bancaire (${t.bankName}, bordereau ${t.externalRef})`;
  return `via ${OPERATOR_NAMES[t.operator] ?? 'Mobile Money'} (ref. ${t.externalRef ?? t.reference})`;
}

class AmountExceededError extends Error {}

export function createFinanceService({ prisma, sms, config }) {
  const today = () => todayIn(config.timezone);

  const receiptInclude = {
    student: { include: { class: { select: { name: true } }, school: true } },
    schoolFee: true,
    recordedBy: { select: { fullName: true, role: true } },
    cancelledBy: { select: { fullName: true, role: true } },
  };

  /** Reçu complet, prêt à imprimer (A4 en deux exemplaires ou ticket 80 mm). */
  function receiptOut(t) {
    const fee = t.schoolFee;
    const s = t.student;
    const balanceAfter = t.feeBalanceAfter !== null && t.feeBalanceAfter !== undefined ? Number(t.feeBalanceAfter) : round2(Number(fee.amountDue) - Number(fee.amountPaid));
    const cashier = t.recordedBy
      ? { name: t.recordedBy.fullName, role: ROLES[t.recordedBy.role]?.label ?? t.recordedBy.role }
      : { name: t.method === 'MOBILE_MONEY' ? 'Paiement Mobile Money en ligne' : '—', role: t.method === 'MOBILE_MONEY' ? 'Confirmé par l’opérateur' : '' };
    return {
      id: t.id,
      transactionId: t.transactionId,
      receiptNumber: t.receiptNumber,
      status: t.status,
      method: t.method,
      methodLabel: PAYMENT_METHODS[t.method]?.label ?? t.method,
      methodDetails: methodDetails(t),
      operator: t.operator,
      operatorName: t.operator ? OPERATOR_NAMES[t.operator] : null,
      externalRef: t.externalRef,
      reference: t.reference,
      bankName: t.bankName,
      payerName: t.payerName,
      payerPhone: t.payerPhone,
      note: t.note,
      amount: Number(t.amount),
      currency: t.currency,
      amountInWords: amountToWordsFr(Number(t.amount), t.currency),
      paidAt: (t.paidAt ?? t.webhookReceivedAt ?? t.createdAt).toISOString(),
      printCount: t.printCount,
      fee: {
        id: fee.id,
        label: fee.label,
        feeType: fee.feeType,
        schoolYear: fee.schoolYear,
        amountDue: Number(fee.amountDue),
        balanceAfter,
        paidBefore: round2(Number(fee.amountDue) - balanceAfter - Number(t.amount)),
      },
      student: {
        id: s.id,
        fullName: studentFullName(s),
        matricule: s.matricule,
        className: s.class?.name ?? null,
        guardianName: s.guardianName,
        guardianPhone: s.guardianPhone,
      },
      school: { name: s.school.name, epstCode: s.school.epstCode, city: s.school.city, province: s.school.province, phone: s.school.phone },
      cashier,
      cancelled:
        t.status === 'CANCELLED'
          ? { at: t.cancelledAt?.toISOString() ?? null, by: t.cancelledBy?.fullName ?? null, reason: t.cancelReason }
          : null,
    };
  }

  /** Ligne compacte pour le journal de caisse et la fiche élève. */
  function paymentRow(t) {
    return {
      id: t.id,
      transactionId: t.transactionId,
      receiptNumber: t.receiptNumber,
      status: t.status,
      method: t.method,
      methodLabel: PAYMENT_METHODS[t.method]?.short ?? t.method,
      methodDetails: methodDetails(t),
      operator: t.operator,
      amount: Number(t.amount),
      currency: t.currency,
      paidAt: (t.paidAt ?? t.webhookReceivedAt ?? t.createdAt).toISOString(),
      studentId: t.studentId,
      studentName: t.student ? studentFullName(t.student) : null,
      matricule: t.student?.matricule ?? null,
      className: t.student?.class?.name ?? null,
      feeLabel: t.schoolFee?.label ?? null,
      payerName: t.payerName,
      cashier: t.recordedBy?.fullName ?? (t.method === 'MOBILE_MONEY' ? 'En ligne' : null),
      cashierId: t.recordedById,
      printCount: t.printCount,
      cancelReason: t.cancelReason,
      cancelledBy: t.cancelledBy?.fullName ?? null,
    };
  }

  async function findInSchool(user, id) {
    const t = await prisma.transaction.findFirst({ where: { id, student: { schoolId: user.schoolId } }, include: receiptInclude });
    if (!t) throw notFound('Paiement introuvable.');
    return t;
  }

  /** Les anciens paiements Mobile Money confirmés (avant la caisse) reçoivent leur numéro à la première demande de reçu. */
  async function ensureReceiptNumber(t) {
    if (t.receiptNumber || !['SUCCESS', 'CANCELLED'].includes(t.status)) return t;
    const paidAt = t.paidAt ?? t.webhookReceivedAt ?? t.createdAt;
    return prisma.$transaction(async (db) => {
      const fresh = await db.transaction.findUniqueOrThrow({ where: { id: t.id } });
      if (fresh.receiptNumber) return db.transaction.findUniqueOrThrow({ where: { id: t.id }, include: receiptInclude });
      const receiptNumber = await allocateReceiptNumber(db, t.student.schoolId, schoolYearOf(todayIn(config.timezone, paidAt)));
      return db.transaction.update({ where: { id: t.id }, data: { receiptNumber, paidAt }, include: receiptInclude });
    });
  }

  async function notifyGuardian(student, message) {
    try {
      const res = await sms.send({
        studentId: student.id,
        phone: student.guardianPhone,
        type: 'PAYMENT_RECEIPT',
        recipientLabel: `Tuteur de ${studentFullName(student)}`,
        message,
      });
      return { status: 'sent', message: res.message };
    } catch (err) {
      // Le paiement est déjà enregistré : un SMS en échec ne doit jamais l'annuler.
      logger.error('SMS de reçu non envoyé', { studentId: student.id, err: err.message });
      return { status: 'failed', message: null };
    }
  }

  return {
    /** Encaissement manuel au bureau de la comptabilité. Idempotent grâce à clientRequestId. */
    async recordPayment(user, body) {
      const input = parseOrThrow(recordSchema, body, 'Encaissement invalide.');

      const replay = await prisma.transaction.findUnique({ where: { clientRequestId: input.clientRequestId }, include: receiptInclude });
      if (replay) {
        if (replay.student.schoolId !== user.schoolId) throw conflict('Identifiant de requête déjà utilisé.');
        return { receipt: receiptOut(replay), replayed: true, sms: null };
      }

      const fee = await prisma.schoolFee.findFirst({
        where: { id: input.schoolFeeId, student: { schoolId: user.schoolId } },
        include: { student: true },
      });
      if (!fee) throw notFound('Frais introuvable.');

      const remaining = round2(Number(fee.amountDue) - Number(fee.amountPaid));
      if (remaining <= 0) throw conflict('Ce frais est déjà soldé.');
      if (input.amount > remaining) throw badRequest(`Le montant dépasse le reste à payer (${formatMoney(remaining, fee.currency)}).`, [{ field: 'amount', message: `Maximum : ${formatMoney(remaining, fee.currency)}.` }]);

      let payerPhone = null;
      if (input.payerPhone) {
        payerPhone = normalizeDrcPhone(input.payerPhone);
        if (!payerPhone) throw badRequest('Numéro de téléphone invalide (ex : 0810000000).', [{ field: 'payerPhone', message: 'Numéro RDC invalide.' }]);
        if (input.method === 'MOBILE_MONEY_DIRECT' && detectOperator(payerPhone) && detectOperator(payerPhone) !== input.operator) {
          throw badRequest(`Le numéro ${formatPhone(payerPhone)} est un numéro ${OPERATOR_NAMES[detectOperator(payerPhone)]}, pas ${OPERATOR_NAMES[input.operator]}.`, [
            { field: 'payerPhone', message: 'Le numéro ne correspond pas à l’opérateur choisi.' },
          ]);
        }
      }

      const externalRef = input.externalRef ? input.externalRef.toUpperCase().replace(/\s+/g, '') : null;
      const bankName = input.method === 'BANK' ? input.bankName : null;
      const operator = input.method === 'MOBILE_MONEY_DIRECT' ? input.operator : null;

      // Une même référence (bordereau ou Mobile Money) ne peut justifier qu'un seul paiement non annulé.
      if (externalRef) {
        const duplicate = await prisma.transaction.findFirst({
          where: {
            status: { in: ['SUCCESS', 'PENDING'] },
            student: { schoolId: user.schoolId },
            OR:
              input.method === 'BANK'
                ? [{ method: 'BANK', externalRef, bankName: { equals: bankName, mode: 'insensitive' } }]
                : [{ method: 'MOBILE_MONEY_DIRECT', externalRef }, { reference: { equals: externalRef, mode: 'insensitive' } }],
          },
          select: { receiptNumber: true, transactionId: true },
        });
        if (duplicate) {
          throw conflict(
            input.method === 'BANK'
              ? `Ce bordereau a déjà été enregistré (reçu n° ${duplicate.receiptNumber ?? duplicate.transactionId}).`
              : `Cette référence Mobile Money a déjà été enregistrée (reçu n° ${duplicate.receiptNumber ?? duplicate.transactionId}).`,
            { receiptNumber: duplicate.receiptNumber },
          );
        }
      }

      const todayIso = today();
      const now = new Date();
      let created;
      try {
        created = await prisma.$transaction(async (db) => {
          // Incrément atomique et conditionnel : jamais de trop-perçu, même si deux caisses encaissent en même temps.
          const rows = await db.$queryRaw`
            UPDATE school_fees
            SET amount_paid = amount_paid + ${input.amount.toString()}::numeric, updated_at = now()
            WHERE id = ${fee.id}::uuid AND amount_paid + ${input.amount.toString()}::numeric <= amount_due
            RETURNING amount_paid, amount_due, due_date`;
          if (rows.length === 0) throw new AmountExceededError();
          const { amount_paid: paid, amount_due: due, due_date: dueDate } = rows[0];
          await db.schoolFee.update({ where: { id: fee.id }, data: { status: computeFeeStatus(paid, due, fromDbDate(dueDate), todayIso) } });
          const receiptNumber = await allocateReceiptNumber(db, user.schoolId, schoolYearOf(todayIso));
          return db.transaction.create({
            data: {
              transactionId: newTransactionId(todayIso),
              method: input.method,
              operator,
              externalRef,
              bankName,
              payerName: input.payerName,
              payerPhone,
              note: input.note,
              amount: input.amount,
              currency: fee.currency,
              status: 'SUCCESS',
              studentId: fee.studentId,
              schoolFeeId: fee.id,
              paidAt: now,
              receiptNumber,
              feeBalanceAfter: round2(Number(due) - Number(paid)),
              clientRequestId: input.clientRequestId,
              recordedById: user.id,
            },
            include: receiptInclude,
          });
        });
      } catch (err) {
        if (err instanceof AmountExceededError) throw conflict('Un autre paiement vient d’être enregistré pour ce frais : le montant dépasse désormais le reste à payer. Actualisez la fiche.');
        if (isUniqueViolation(err)) {
          const again = await prisma.transaction.findUnique({ where: { clientRequestId: input.clientRequestId }, include: receiptInclude });
          if (again) return { receipt: receiptOut(again), replayed: true, sms: null };
        }
        throw err;
      }

      const balance = Number(created.feeBalanceAfter);
      const smsResult = await notifyGuardian(
        fee.student,
        `Recu Ecole n. ${created.receiptNumber} : ${formatMoney(created.amount, created.currency)} recu ${methodForSms(created)} pour ${studentFullName(fee.student)} (${fee.label}). ` +
          (balance > 0 ? `Reste a payer : ${formatMoney(balance, created.currency)}.` : 'Frais solde. Merci.'),
      );
      logger.info('Encaissement enregistré', { receiptNumber: created.receiptNumber, method: created.method, amount: Number(created.amount), by: user.id });
      return { receipt: receiptOut(created), replayed: false, sms: smsResult };
    },

    async receipt(user, id) {
      const t = await ensureReceiptNumber(await findInSchool(user, id));
      if (!['SUCCESS', 'CANCELLED'].includes(t.status)) throw conflict('Aucun reçu : ce paiement n’a pas été confirmé.');
      return { receipt: receiptOut(t) };
    },

    /** Enregistre une impression : la réponse indique si le document doit porter la mention DUPLICATA. */
    async markPrinted(user, id) {
      const t = await findInSchool(user, id);
      if (!['SUCCESS', 'CANCELLED'].includes(t.status)) throw conflict('Aucun reçu à imprimer pour ce paiement.');
      const updated = await prisma.transaction.update({ where: { id: t.id }, data: { printCount: { increment: 1 } }, select: { printCount: true } });
      return { printCount: updated.printCount, duplicate: updated.printCount > 1 };
    },

    /** Annulation par la direction : le reçu reste dans le journal, barré « ANNULÉ », et le montant est retiré du frais. */
    async cancelPayment(user, id, body) {
      const { reason } = parseOrThrow(cancelSchema, body, 'Annulation invalide.');
      const t = await findInSchool(user, id);
      if (t.status === 'CANCELLED') throw conflict('Ce reçu est déjà annulé.');
      if (t.status !== 'SUCCESS') throw conflict('Seul un paiement confirmé peut être annulé.');

      const todayIso = today();
      const updated = await prisma.$transaction(async (db) => {
        const claimed = await db.transaction.updateMany({
          where: { id: t.id, status: 'SUCCESS' },
          data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: user.id, cancelReason: reason },
        });
        if (claimed.count === 0) throw conflict('Ce reçu vient d’être annulé.');
        const rows = await db.$queryRaw`
          UPDATE school_fees
          SET amount_paid = GREATEST(amount_paid - ${t.amount.toString()}::numeric, 0), updated_at = now()
          WHERE id = ${t.schoolFeeId}::uuid
          RETURNING amount_paid, amount_due, due_date`;
        const { amount_paid: paid, amount_due: due, due_date: dueDate } = rows[0];
        await db.schoolFee.update({ where: { id: t.schoolFeeId }, data: { status: computeFeeStatus(paid, due, fromDbDate(dueDate), todayIso) } });
        return db.transaction.findUniqueOrThrow({ where: { id: t.id }, include: receiptInclude });
      });

      const withNumber = await ensureReceiptNumber(updated);
      const smsResult = await notifyGuardian(
        t.student,
        `Ecole : le recu n. ${withNumber.receiptNumber} (${formatMoney(t.amount, t.currency)}, ${t.schoolFee.label}) pour ${studentFullName(t.student)} a ete annule. ` +
          'Si vous avez bien paye, presentez-vous a la comptabilite avec votre recu.',
      );
      logger.warn('Reçu annulé', { receiptNumber: withNumber.receiptNumber, by: user.id, reason });
      return { receipt: receiptOut(withNumber), sms: smsResult };
    },

    /** Journal de caisse : encaissements confirmés (et reçus annulés) d'un jour ou d'une période. */
    async journal(user, query) {
      const q = parseOrThrow(journalSchema, query, 'Période invalide.');
      const from = q.from ?? q.to ?? today();
      const to = q.to ?? from;
      if (to < from) throw badRequest('La date de fin précède la date de début.');
      if (daysBetween(from, to) >= MAX_JOURNAL_DAYS) throw badRequest(`Période limitée à ${MAX_JOURNAL_DAYS} jours.`);
      const start = zonedDayRange(from, config.timezone).start;
      const end = zonedDayRange(to, config.timezone).end;

      const school = await prisma.school.findUniqueOrThrow({ where: { id: user.schoolId } });
      const rows = await prisma.transaction.findMany({
        where: {
          student: { schoolId: user.schoolId },
          status: { in: ['SUCCESS', 'CANCELLED'] },
          paidAt: { gte: start, lt: end },
          ...(q.method ? { method: q.method } : {}),
        },
        orderBy: [{ paidAt: 'asc' }, { createdAt: 'asc' }],
        take: 2000,
        include: {
          student: { select: { id: true, matricule: true, lastName: true, middleName: true, firstName: true, class: { select: { name: true } } } },
          schoolFee: { select: { label: true } },
          recordedBy: { select: { fullName: true } },
          cancelledBy: { select: { fullName: true } },
        },
      });

      const byCurrency = {};
      const byMethod = {};
      const byCashier = {};
      for (const t of rows) {
        if (t.status !== 'SUCCESS') continue;
        const amount = Number(t.amount);
        byCurrency[t.currency] = round2((byCurrency[t.currency] ?? 0) + amount);
        const m = (byMethod[t.method] ??= { method: t.method, label: PAYMENT_METHODS[t.method]?.short ?? t.method, count: 0, totals: {} });
        m.count += 1;
        m.totals[t.currency] = round2((m.totals[t.currency] ?? 0) + amount);
        const cashierName = t.recordedBy?.fullName ?? 'Paiements en ligne';
        const c = (byCashier[cashierName] ??= { cashier: cashierName, count: 0, totals: {} });
        c.count += 1;
        c.totals[t.currency] = round2((c.totals[t.currency] ?? 0) + amount);
      }

      return {
        from,
        to,
        generatedAt: new Date().toISOString(),
        school: { name: school.name, epstCode: school.epstCode, city: school.city, province: school.province, phone: school.phone },
        count: rows.filter((t) => t.status === 'SUCCESS').length,
        cancelledCount: rows.filter((t) => t.status === 'CANCELLED').length,
        totals: Object.entries(byCurrency).map(([currency, total]) => ({ currency, total })),
        byMethod: Object.values(byMethod),
        byCashier: Object.values(byCashier),
        payments: rows.map(paymentRow),
      };
    },

    /** Indicateurs de caisse du jour pour l'accueil de la comptabilité. */
    async daySummary(user, dateIso) {
      const { start, end } = zonedDayRange(dateIso, config.timezone);
      const groups = await prisma.transaction.groupBy({
        by: ['currency', 'method'],
        where: { student: { schoolId: user.schoolId }, status: 'SUCCESS', paidAt: { gte: start, lt: end } },
        _sum: { amount: true },
        _count: { _all: true },
      });
      const totals = {};
      let count = 0;
      for (const g of groups) {
        totals[g.currency] = round2((totals[g.currency] ?? 0) + Number(g._sum.amount ?? 0));
        count += g._count._all;
      }
      return {
        date: dateIso,
        count,
        totals: Object.entries(totals).map(([currency, total]) => ({ currency, total })),
        byMethod: groups.map((g) => ({ method: g.method, currency: g.currency, count: g._count._all, total: round2(Number(g._sum.amount ?? 0)) })),
      };
    },

    paymentRow,
    /** Exposé pour la fiche élève (historique des paiements). */
    rowInclude: { recordedBy: { select: { fullName: true } }, cancelledBy: { select: { fullName: true } }, schoolFee: { select: { label: true } } },
  };
}
