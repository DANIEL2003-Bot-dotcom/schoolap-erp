import { randomUUID } from 'node:crypto';
import { formatDateTimeFr } from '../utils/dates.js';
import { formatPhone } from '../utils/phone.js';

const GSM7 = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);

/** Translittère les caractères hors alphabet GSM-7 (ex : "ï" → "i") pour rester sur 1 SMS. */
export function toGsm7(text) {
  let out = '';
  for (const ch of text) {
    if (GSM7.has(ch)) {
      out += ch;
      continue;
    }
    const stripped = ch.normalize('NFD').replace(/\p{M}/gu, '');
    out += [...stripped].every((c) => GSM7.has(c)) ? stripped : '?';
  }
  return out;
}

export function smsSegments(text) {
  const gsm = [...text].every((c) => GSM7.has(c));
  const len = [...text].length;
  if (gsm) return len <= 160 ? 1 : Math.ceil(len / 153);
  return len <= 70 ? 1 : Math.ceil(len / 67);
}

const TYPE_LABEL = {
  ABSENCE_ALERT: "ALERTE D'ABSENCE",
  FEE_REMINDER: 'RELANCE FRAIS SCOLAIRES',
  PAYMENT_RECEIPT: 'REÇU DE PAIEMENT',
};

/**
 * Passerelle SMS simulée : affiche un bloc console détaillé et journalise l'envoi
 * dans la table sms_logs (preuve d'envoi consultable par la direction).
 */
export function createSmsService({ prisma, config, print = console.log }) {
  return {
    async send({ studentId = null, phone, message, type, recipientLabel = 'Tuteur' }) {
      const text = toGsm7(message);
      const providerId = `SMS-${randomUUID().slice(0, 8).toUpperCase()}`;
      const segments = smsSegments(text);
      const sentAt = new Date();

      const line = '═'.repeat(64);
      print(
        [
          `╔${line}`,
          '║ 📱 PASSERELLE SMS — ENVOI AUTOMATISÉ (SIMULATION)',
          `╠${line}`,
          `║ Type         : ${TYPE_LABEL[type] ?? type}`,
          `║ Expéditeur   : ${config.smsSenderId}`,
          `║ Destinataire : ${formatPhone(phone)} (${recipientLabel})`,
          `║ Horodatage   : ${formatDateTimeFr(sentAt, config.timezone)} (${config.timezone})`,
          `║ Encodage     : ${segments === 1 ? 'GSM-7' : 'GSM-7/UCS-2'} · ${text.length} caractères · ${segments} SMS facturé(s)`,
          `║ Message      : ${text}`,
          `║ Statut       : ✅ ACCEPTÉ PAR L'OPÉRATEUR — ID ${providerId}`,
          `╚${line}`,
        ].join('\n'),
      );

      await prisma.smsLog.create({
        data: { studentId, phone, message: text, type, status: 'SENT', providerId },
      });
      return { providerId, segments, message: text, sentAt };
    },
  };
}
