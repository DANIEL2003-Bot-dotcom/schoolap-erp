import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { badRequest, conflict, notFound, parseOrThrow, unauthorized } from '../utils/httpError.js';
import { fromDbDate, todayIn } from '../utils/dates.js';
import { detectOperator, formatPhone, maskPhone, normalizeDrcPhone } from '../utils/phone.js';
import { studentFullName } from '../utils/names.js';
import { logger } from '../utils/logger.js';
import { computeFeeStatus, formatMoney } from './fees.js';

export const OPERATORS = Object.freeze({
  MPESA: { name: 'M-Pesa', company: 'Vodacom Congo', refPrefix: 'MP' },
  ORANGE_MONEY: { name: 'Orange Money', company: 'Orange RDC', refPrefix: 'OM' },
  AIRTEL_MONEY: { name: 'Airtel Money', company: 'Airtel Congo', refPrefix: 'AM' },
});

const PENDING_WINDOW_MS = 2 * 60_000;
const OVERPAYMENT_REASON = 'Frais déjà soldé par un autre paiement : remboursement à effectuer';

class OverpaymentError extends Error {}

const FAILURE_REASONS = ['Solde insuffisant', 'Code PIN incorrect', 'Délai de confirmation expiré'];
const twoDecimals = (v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6;

const initSchema = z
  .object({
    studentId: z.uuid({ error: 'studentId doit être un UUID.' }).optional(),
    matricule: z.string().trim().min(1).max(40).optional(),
    schoolFeeId: z.uuid({ error: 'schoolFeeId doit être un UUID.' }),
    operator: z.enum(['MPESA', 'ORANGE_MONEY', 'AIRTEL_MONEY'], { error: 'operator : MPESA, ORANGE_MONEY ou AIRTEL_MONEY.' }),
    phone: z.string({ error: 'phone est obligatoire.' }).min(9).max(20),
    amount: z.number({ error: 'amount doit être un nombre.' }).positive('amount doit être > 0.').max(100000).refine(twoDecimals, '2 décimales maximum.'),
  })
  .refine((b) => b.studentId || b.matricule, { message: 'studentId ou matricule est obligatoire.', path: ['studentId'] });

const webhookSchema = z.object({
  transactionId: z.string().min(1).max(64),
  reference: z.string().min(1).max(64),
  operator: z.enum(['MPESA', 'ORANGE_MONEY', 'AIRTEL_MONEY']),
  status: z.enum(['SUCCESS', 'FAILED']),
  amount: z.number().positive(),
  currency: z.enum(['USD', 'CDF']),
  payerPhone: z.string().optional(),
  reason: z.string().max(200).optional(),
});

export function signWebhook(rawBody, secret) {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

export function verifyWebhookSignature(rawBody, header, secret) {
  if (typeof header !== 'string' || !rawBody) return false;
  const expected = Buffer.from(signWebhook(rawBody, secret));
  const received = Buffer.from(header);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function newTransactionId(todayIso) {
  return `TX-${todayIso.replaceAll('-', '')}-${randomBytes(4).toString('hex').toUpperCase()}`;
}

function newOperatorReference(operator) {
  return `${OPERATORS[operator].refPrefix}${Date.now().toString(36).toUpperCase()}${randomBytes(3).toString('hex').toUpperCase()}`;
}

export function createMobileMoneyService({ prisma, sms, config, dispatchWebhook }) {
  const sendWebhook =
    dispatchWebhook ??
    (async (rawBody, signature) => {
      const res = await fetch(`http://127.0.0.1:${config.port}/api/payments/mobile-money/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Signature': signature },
        body: rawBody,
      });
      return res.status;
    });

  /** Simule la plateforme de l'opérateur : le client valide (ou non) avec son PIN, puis l'opérateur rappelle le webhook. */
  function scheduleOperatorCallback(tx) {
    const timer = setTimeout(async () => {
      const success = Math.random() >= config.simulatedPaymentFailureRate;
      const payload = {
        transactionId: tx.transactionId,
        reference: tx.reference,
        operator: tx.operator,
        status: success ? 'SUCCESS' : 'FAILED',
        amount: Number(tx.amount),
        currency: tx.currency,
        payerPhone: tx.payerPhone,
        ...(success ? {} : { reason: FAILURE_REASONS[Math.floor(Math.random() * FAILURE_REASONS.length)] }),
      };
      const rawBody = JSON.stringify(payload);
      try {
        const status = await sendWebhook(rawBody, signWebhook(rawBody, config.webhookSecret));
        logger.info('Webhook opérateur simulé envoyé', { transactionId: tx.transactionId, httpStatus: status, result: payload.status });
      } catch (err) {
        logger.error('Webhook opérateur simulé en échec', { transactionId: tx.transactionId, err: err.message });
      }
    }, config.operatorCallbackDelayMs);
    timer.unref?.();
  }

  return {
    async initiate(body) {
      const input = parseOrThrow(initSchema, body, 'Demande de paiement invalide.');

      const phone = normalizeDrcPhone(input.phone);
      if (!phone) throw badRequest('Numéro de téléphone invalide (ex : +243810000000 ou 0810000000).');
      const phoneOperator = detectOperator(phone);
      if (phoneOperator !== input.operator) {
        throw badRequest(
          phoneOperator
            ? `Le numéro ${formatPhone(phone)} est un numéro ${OPERATORS[phoneOperator].name}, pas ${OPERATORS[input.operator].name}.`
            : `Le numéro ${formatPhone(phone)} ne correspond à aucun opérateur Mobile Money pris en charge.`,
        );
      }

      const fee = await prisma.schoolFee.findUnique({ where: { id: input.schoolFeeId }, include: { student: true } });
      const studentMatches =
        fee && (input.studentId ? fee.studentId === input.studentId : fee.student.matricule === input.matricule);
      if (!fee || !studentMatches) throw notFound('Frais introuvable pour cet élève.');

      const remaining = Number((Number(fee.amountDue) - Number(fee.amountPaid)).toFixed(2));
      if (remaining <= 0) throw conflict('Ce frais est déjà soldé.');
      if (input.amount > remaining) {
        throw badRequest(`Le montant dépasse le reste à payer (${formatMoney(remaining, fee.currency)}).`);
      }

      // Un seul paiement en attente par frais (quel que soit le numéro) : évite les trop-perçus
      // si deux tuteurs paient le même frais au même moment.
      const recentPending = await prisma.transaction.findFirst({
        where: { schoolFeeId: fee.id, status: 'PENDING', createdAt: { gt: new Date(Date.now() - PENDING_WINDOW_MS) } },
      });
      if (recentPending) {
        throw conflict('Un paiement est déjà en attente de confirmation pour ce frais. Patientez deux minutes.', {
          transactionId: recentPending.transactionId,
        });
      }

      const created = await prisma.transaction.create({
        data: {
          transactionId: newTransactionId(todayIn(config.timezone)),
          operator: input.operator,
          payerPhone: phone,
          amount: input.amount,
          currency: fee.currency,
          studentId: fee.studentId,
          schoolFeeId: fee.id,
        },
      });

      // Appel simulé à l'API de l'opérateur (push USSD vers le téléphone du payeur).
      const tx = await prisma.transaction.update({
        where: { id: created.id },
        data: { reference: newOperatorReference(input.operator) },
      });
      logger.info('Paiement Mobile Money initié', {
        transactionId: tx.transactionId,
        operator: tx.operator,
        reference: tx.reference,
        payer: maskPhone(phone),
        amount: Number(tx.amount),
      });

      if (config.simulateOperatorCallback) scheduleOperatorCallback(tx);

      return {
        transactionId: tx.transactionId,
        reference: tx.reference,
        status: tx.status,
        operator: tx.operator,
        amount: Number(tx.amount),
        currency: tx.currency,
        student: studentFullName(fee.student),
        message: `Confirmez le paiement de ${formatMoney(tx.amount, tx.currency)} sur votre téléphone ${OPERATORS[tx.operator].name} en saisissant votre code PIN.`,
      };
    },

    async handleWebhook(rawBody, signatureHeader) {
      if (!verifyWebhookSignature(rawBody, signatureHeader, config.webhookSecret)) {
        throw unauthorized('Signature du webhook invalide.');
      }
      let json;
      try {
        json = JSON.parse(rawBody.toString('utf8'));
      } catch {
        throw badRequest('Corps du webhook illisible.');
      }
      const payload = parseOrThrow(webhookSchema, json, 'Webhook invalide.');

      const tx = await prisma.transaction.findUnique({
        where: { transactionId: payload.transactionId },
        include: { schoolFee: { include: { student: true } } },
      });
      if (!tx) throw notFound('Transaction inconnue.');
      if (tx.reference !== payload.reference || tx.operator !== payload.operator) {
        throw badRequest('Référence ou opérateur incohérent avec la transaction.');
      }
      if (tx.status !== 'PENDING') {
        return { processed: false, alreadyProcessed: true, transactionId: tx.transactionId, status: tx.status };
      }

      const now = new Date();
      if (payload.status === 'SUCCESS' && (Number(tx.amount) !== payload.amount || tx.currency !== payload.currency)) {
        await prisma.transaction.updateMany({
          where: { id: tx.id, status: 'PENDING' },
          data: { status: 'FAILED', failureReason: 'Montant confirmé incohérent', webhookReceivedAt: now },
        });
        logger.warn('Webhook avec montant incohérent', { transactionId: tx.transactionId });
        return { processed: true, transactionId: tx.transactionId, status: 'FAILED' };
      }

      if (payload.status === 'FAILED') {
        await prisma.transaction.updateMany({
          where: { id: tx.id, status: 'PENDING' },
          data: { status: 'FAILED', failureReason: payload.reason ?? 'Refusé par l’opérateur', webhookReceivedAt: now },
        });
        return { processed: true, transactionId: tx.transactionId, status: 'FAILED', reason: payload.reason ?? null };
      }

      const today = todayIn(config.timezone);
      let fee;
      try {
        fee = await prisma.$transaction(async (db) => {
          const claimed = await db.transaction.updateMany({
            where: { id: tx.id, status: 'PENDING' },
            data: { status: 'SUCCESS', webhookReceivedAt: now },
          });
          if (claimed.count === 0) return null;
          // Incrément atomique et conditionnel : jamais de trop-perçu, même avec des webhooks simultanés.
          const rows = await db.$queryRaw`
            UPDATE school_fees
            SET amount_paid = amount_paid + ${tx.amount.toString()}::numeric, updated_at = now()
            WHERE id = ${tx.schoolFeeId}::uuid AND amount_paid + ${tx.amount.toString()}::numeric <= amount_due
            RETURNING id`;
          if (rows.length === 0) throw new OverpaymentError(OVERPAYMENT_REASON);
          const updated = await db.schoolFee.findUniqueOrThrow({ where: { id: tx.schoolFeeId } });
          return db.schoolFee.update({
            where: { id: updated.id },
            data: { status: computeFeeStatus(updated.amountPaid, updated.amountDue, fromDbDate(updated.dueDate), today) },
          });
        });
      } catch (err) {
        if (!(err instanceof OverpaymentError)) throw err;
        await prisma.transaction.updateMany({
          where: { id: tx.id, status: 'PENDING' },
          data: { status: 'FAILED', failureReason: OVERPAYMENT_REASON, webhookReceivedAt: now },
        });
        logger.warn('Paiement refusé : il dépasserait le montant dû', { transactionId: tx.transactionId });
        return { processed: true, transactionId: tx.transactionId, status: 'FAILED', reason: OVERPAYMENT_REASON };
      }
      if (!fee) return { processed: false, alreadyProcessed: true, transactionId: tx.transactionId, status: 'SUCCESS' };

      const remaining = Math.max(0, Number(fee.amountDue) - Number(fee.amountPaid));
      const student = tx.schoolFee.student;
      await sms.send({
        studentId: student.id,
        phone: student.guardianPhone,
        type: 'PAYMENT_RECEIPT',
        recipientLabel: `Tuteur de ${studentFullName(student)}`,
        message:
          `Reçu École : ${formatMoney(tx.amount, tx.currency)} reçu via ${OPERATORS[tx.operator].name} ` +
          `(réf. ${tx.reference}) pour ${studentFullName(student)}. ` +
          (remaining > 0 ? `Reste à payer : ${formatMoney(remaining, fee.currency)}.` : 'Frais soldé. Merci.'),
      });

      return {
        processed: true,
        transactionId: tx.transactionId,
        status: 'SUCCESS',
        fee: {
          id: fee.id,
          amountDue: Number(fee.amountDue),
          amountPaid: Number(fee.amountPaid),
          remaining: Number(remaining.toFixed(2)),
          status: fee.status,
        },
      };
    },

    async getStatus(transactionId) {
      const tx = await prisma.transaction.findUnique({ where: { transactionId }, include: { schoolFee: true } });
      if (!tx) throw notFound('Transaction inconnue.');
      return {
        transactionId: tx.transactionId,
        reference: tx.reference,
        operator: tx.operator,
        status: tx.status,
        amount: Number(tx.amount),
        currency: tx.currency,
        failureReason: tx.failureReason,
        createdAt: tx.createdAt.toISOString(),
        confirmedAt: tx.webhookReceivedAt?.toISOString() ?? null,
        fee: {
          id: tx.schoolFee.id,
          label: tx.schoolFee.label,
          status: tx.schoolFee.status,
          remaining: Number(Math.max(0, Number(tx.schoolFee.amountDue) - Number(tx.schoolFee.amountPaid)).toFixed(2)),
        },
      };
    },
  };
}
