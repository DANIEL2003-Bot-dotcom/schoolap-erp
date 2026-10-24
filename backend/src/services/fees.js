import { conflict, forbidden, notFound, tooManyRequests } from '../utils/httpError.js';
import { formatDateFr, fromDbDate, toDbDate, todayIn } from '../utils/dates.js';
import { studentFullName } from '../utils/names.js';

export const REMINDER_COOLDOWN_HOURS = 24;

export function formatMoney(amount, currency) {
  const n = Number(amount);
  return currency === 'CDF' ? `${Math.round(n).toLocaleString('fr-FR').replace(/\u202f|\u00a0/g, ' ')} FC` : `${n.toFixed(2)} USD`;
}

/** SOLDE si payé en totalité, INSOLVABLE si l'échéance est dépassée, sinon EN_COURS. */
export function computeFeeStatus(amountPaid, amountDue, dueDateIso, todayIso) {
  if (Number(amountPaid) >= Number(amountDue)) return 'SOLDE';
  return dueDateIso < todayIso ? 'INSOLVABLE' : 'EN_COURS';
}

export function createFeesService({ prisma, sms, config }) {
  return {
    /** Recalcule les statuts (une échéance qui passe rend un frais INSOLVABLE). */
    async refreshStatuses() {
      const today = toDbDate(todayIn(config.timezone));
      return prisma.$executeRaw`
        UPDATE school_fees
        SET status = (CASE
              WHEN amount_paid >= amount_due THEN 'SOLDE'
              WHEN due_date < ${today} THEN 'INSOLVABLE'
              ELSE 'EN_COURS' END)::"FeeStatus",
            updated_at = now()
        WHERE status <> (CASE
              WHEN amount_paid >= amount_due THEN 'SOLDE'
              WHEN due_date < ${today} THEN 'INSOLVABLE'
              ELSE 'EN_COURS' END)::"FeeStatus"`;
    },

    async sendReminder(user, feeId) {
      const fee = await prisma.schoolFee.findUnique({ where: { id: feeId }, include: { student: true } });
      if (!fee) throw notFound('Frais scolaire introuvable.');
      if (fee.student.schoolId !== user.schoolId) throw forbidden('Ce frais n’appartient pas à votre école.');

      const remaining = Number(fee.amountDue) - Number(fee.amountPaid);
      if (remaining <= 0) throw conflict('Ce frais est déjà soldé : aucune relance nécessaire.');

      if (fee.lastReminderAt) {
        const nextAllowedAt = new Date(fee.lastReminderAt.getTime() + REMINDER_COOLDOWN_HOURS * 3_600_000);
        if (nextAllowedAt > new Date()) {
          throw tooManyRequests(`Ce parent a déjà été relancé il y a moins de ${REMINDER_COOLDOWN_HOURS} h.`, {
            lastReminderAt: fee.lastReminderAt.toISOString(),
            nextAllowedAt: nextAllowedAt.toISOString(),
          });
        }
      }

      // Réservation atomique : deux clics simultanés n'envoient qu'un seul SMS.
      const now = new Date();
      const claimed = await prisma.schoolFee.updateMany({
        where: {
          id: fee.id,
          OR: [{ lastReminderAt: null }, { lastReminderAt: { lt: new Date(now.getTime() - REMINDER_COOLDOWN_HOURS * 3_600_000) } }],
        },
        data: { lastReminderAt: now },
      });
      if (claimed.count === 0) throw tooManyRequests('Une relance vient d’être envoyée pour ce frais.');

      const message =
        `Rappel École : solde impayé de ${formatMoney(remaining, fee.currency)} (${fee.label}) pour ` +
        `${studentFullName(fee.student)}, échéance du ${formatDateFr(fromDbDate(fee.dueDate))}. ` +
        'Payez via M-Pesa, Orange Money ou Airtel Money.';

      try {
        const result = await sms.send({
          studentId: fee.studentId,
          phone: fee.student.guardianPhone,
          message,
          type: 'FEE_REMINDER',
          recipientLabel: `Tuteur de ${studentFullName(fee.student)}`,
        });
        return {
          feeId: fee.id,
          remaining: Number(remaining.toFixed(2)),
          currency: fee.currency,
          remindedAt: now.toISOString(),
          sms: { status: 'sent', providerId: result.providerId, message: result.message },
        };
      } catch (err) {
        await prisma.schoolFee.update({ where: { id: fee.id }, data: { lastReminderAt: fee.lastReminderAt } });
        throw err;
      }
    },
  };
}
