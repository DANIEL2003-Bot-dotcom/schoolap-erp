import { z } from 'zod';
import { badRequest, notFound, parseOrThrow } from '../utils/httpError.js';
import { logger } from '../utils/logger.js';
import { normalizeDrcPhone } from '../utils/phone.js';
import { studentFullName } from '../utils/names.js';
import { zonedDayRange, todayIn } from '../utils/dates.js';
import { WHATSAPP_TEMPLATES } from './whatsappTemplates.js';

export const MESSAGE_TYPE_LABELS = Object.freeze({
  ABSENCE_ALERT: "Alerte d'absence",
  PERFORMANCE_ALERT: 'Alerte résultats',
  PAYMENT_RECEIPT: 'Reçu de paiement',
  FEE_REMINDER: 'Rappel de paiement',
});

const FAILURE_WINDOW_DAYS = 7;
const testSchema = z.object({ phone: z.string({ error: 'Numéro obligatoire.' }).min(1, 'Numéro obligatoire.') });

/**
 * Messages aux tuteurs : WhatsApp quand il est relié et que le tuteur l'accepte, sinon SMS.
 * Si WhatsApp échoue, AUCUN SMS de secours n'est envoyé (choix de l'école) : l'échec est
 * journalisé et affiché dans le tableau de bord pour que l'école appelle le parent.
 *
 * Même signature que le service SMS : send({ studentId, phone, message, type, recipientLabel, template })
 * où template = { name, params } (variables à partir de {{2}} ; {{1}} = nom de l'école).
 * Retourne { channel, status: 'sent' | 'failed', providerId, message, sentAt, error? }.
 */
export function createMessagingService({ prisma, config, sms, whatsapp }) {
  async function recipientContext(studentId) {
    if (!studentId) return null;
    return prisma.student.findUnique({ where: { id: studentId }, select: { guardianWhatsapp: true, school: { select: { name: true } } } });
  }

  async function viaSms(input) {
    const res = await sms.send(input);
    return { channel: 'SMS', status: 'sent', providerId: res.providerId, message: res.message, sentAt: res.sentAt };
  }

  return {
    channelMode: whatsapp.mode,

    async send({ studentId = null, phone, message, type, recipientLabel = 'Tuteur', template = null }) {
      if (!whatsapp.isActive || !template) return viaSms({ studentId, phone, message, type, recipientLabel });
      const ctx = await recipientContext(studentId);
      if (ctx && !ctx.guardianWhatsapp) return viaSms({ studentId, phone, message, type, recipientLabel });

      const params = [ctx?.school.name ?? 'Votre école', ...template.params];
      const sentAt = new Date();
      try {
        const res = await whatsapp.sendTemplate({ to: phone, template: template.name, params, recipientLabel, type });
        await prisma.smsLog.create({ data: { studentId, phone, message: res.message, type, channel: 'WHATSAPP', status: 'SENT', providerId: res.id } });
        return { channel: 'WHATSAPP', status: 'sent', providerId: res.id, message: res.message, sentAt };
      } catch (err) {
        const text = (() => {
          try {
            return whatsapp.render(template.name, params);
          } catch {
            return message;
          }
        })();
        await prisma.smsLog.create({ data: { studentId, phone, message: text, type, channel: 'WHATSAPP', status: 'FAILED', error: err.message } });
        logger.warn('Message WhatsApp non envoyé', { studentId, type, error: err.message });
        return { channel: 'WHATSAPP', status: 'failed', providerId: null, message: text, sentAt, error: err.message };
      }
    },

    /** Bloc « messages aux tuteurs » du tableau de bord : compteurs du jour et échecs à traiter. */
    async dashboardBlock(schoolId, isoDate) {
      const day = zonedDayRange(isoDate, config.timezone);
      const since = new Date(day.end.getTime() - FAILURE_WINDOW_DAYS * 86_400_000);
      const [groups, failures] = await Promise.all([
        prisma.smsLog.groupBy({
          by: ['channel', 'status'],
          where: { student: { schoolId }, createdAt: { gte: day.start, lt: day.end } },
          _count: { _all: true },
        }),
        prisma.smsLog.findMany({
          where: { student: { schoolId }, channel: 'WHATSAPP', status: 'FAILED', handledAt: null, createdAt: { gte: since, lt: day.end } },
          include: { student: { select: { id: true, lastName: true, middleName: true, firstName: true, guardianName: true, class: { select: { name: true } } } } },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
      ]);
      const count = (channel, status) => groups.filter((g) => g.channel === channel && (!status || g.status === status)).reduce((n, g) => n + g._count._all, 0);
      return {
        whatsappMode: whatsapp.mode,
        today: {
          whatsapp: { total: count('WHATSAPP'), sent: count('WHATSAPP', 'SENT'), delivered: count('WHATSAPP', 'DELIVERED'), read: count('WHATSAPP', 'READ'), failed: count('WHATSAPP', 'FAILED') },
          sms: count('SMS'),
        },
        failures: failures.map((f) => ({
          id: f.id,
          type: f.type,
          typeLabel: MESSAGE_TYPE_LABELS[f.type] ?? f.type,
          studentId: f.student?.id ?? null,
          studentName: f.student ? studentFullName(f.student) : null,
          className: f.student?.class?.name ?? null,
          guardianName: f.student?.guardianName ?? null,
          guardianPhone: f.phone,
          error: f.error,
          createdAt: f.createdAt.toISOString(),
        })),
      };
    },

    /** Dernier message d'absence par élève pour une journée (état WhatsApp / SMS dans la liste des absents). */
    async absenceMessages(studentIds, isoDate) {
      if (studentIds.length === 0) return new Map();
      const day = zonedDayRange(isoDate, config.timezone);
      const rows = await prisma.smsLog.findMany({
        where: { studentId: { in: studentIds }, type: 'ABSENCE_ALERT', createdAt: { gte: day.start, lt: day.end } },
        select: { studentId: true, channel: true, status: true, error: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      });
      const map = new Map();
      for (const r of rows) if (!map.has(r.studentId)) map.set(r.studentId, r);
      return map;
    },

    /** L'école a joint le parent par un autre moyen : l'échec disparaît de la liste. */
    async markHandled(user, id) {
      const log = await prisma.smsLog.findFirst({ where: { id, student: { schoolId: user.schoolId }, status: 'FAILED' } });
      if (!log) throw notFound('Message introuvable.');
      const updated = await prisma.smsLog.update({ where: { id }, data: { handledAt: log.handledAt ?? new Date(), handledById: log.handledById ?? user.id } });
      return { message: { id: updated.id, handledAt: updated.handledAt.toISOString() } };
    },

    /** Page « WhatsApp » de l'Administrateur : liaison Meta, numéro, modèles, tuteurs, statistiques. */
    async adminStatus(user) {
      const since = new Date(Date.now() - 7 * 86_400_000);
      const [guardians, stats] = await Promise.all([
        prisma.student.groupBy({ by: ['guardianWhatsapp'], where: { schoolId: user.schoolId, isActive: true }, _count: { _all: true } }),
        prisma.smsLog.groupBy({ by: ['channel', 'status'], where: { student: { schoolId: user.schoolId }, createdAt: { gte: since } }, _count: { _all: true } }),
      ]);
      const stat = (channel, status) => stats.filter((g) => g.channel === channel && (!status || g.status === status)).reduce((n, g) => n + g._count._all, 0);
      const out = {
        mode: whatsapp.mode,
        configuration: {
          accessToken: Boolean(config.whatsapp.accessToken),
          phoneNumberId: Boolean(config.whatsapp.phoneNumberId),
          businessAccountId: Boolean(config.whatsapp.businessAccountId),
          appSecret: Boolean(config.whatsapp.appSecret),
          verifyToken: Boolean(config.whatsapp.verifyToken),
          apiVersion: config.whatsapp.apiVersion,
          language: config.whatsapp.language,
          webhookPath: '/api/whatsapp/webhook',
        },
        phone: null,
        phoneError: null,
        templates: Object.entries(WHATSAPP_TEMPLATES).map(([name, t]) => ({ name, label: t.label, body: t.body, status: whatsapp.mode === 'live' ? 'UNKNOWN' : 'NOT_CONNECTED', category: null, rejectedReason: null })),
        templatesError: null,
        guardians: {
          whatsapp: guardians.find((g) => g.guardianWhatsapp)?._count._all ?? 0,
          sms: guardians.find((g) => !g.guardianWhatsapp)?._count._all ?? 0,
        },
        last7Days: {
          whatsapp: { total: stat('WHATSAPP'), sent: stat('WHATSAPP', 'SENT'), delivered: stat('WHATSAPP', 'DELIVERED'), read: stat('WHATSAPP', 'READ'), failed: stat('WHATSAPP', 'FAILED') },
          sms: stat('SMS'),
        },
      };
      if (whatsapp.mode === 'live') {
        const [phone, templates] = await Promise.allSettled([whatsapp.phoneInfo(), config.whatsapp.businessAccountId ? whatsapp.templatesStatus() : Promise.reject(new Error('Identifiant du compte WhatsApp Business manquant : état des modèles indisponible.'))]);
        if (phone.status === 'fulfilled') out.phone = phone.value;
        else out.phoneError = phone.reason.message;
        if (templates.status === 'fulfilled') out.templates = templates.value;
        else out.templatesError = templates.reason.message;
      }
      return { whatsapp: out };
    },

    async submitTemplates() {
      return whatsapp.submitMissingTemplates();
    },

    /** Message de test vers un numéro choisi par l'Administrateur (son propre téléphone, par exemple). */
    async sendTest(user, body) {
      const input = parseOrThrow(testSchema, body, 'Numéro invalide.');
      const phone = normalizeDrcPhone(input.phone);
      if (!phone) throw badRequest('Numéro invalide : format 0970000000 ou +243970000000.');
      if (!whatsapp.isActive) throw badRequest('WhatsApp n’est pas encore relié au serveur.');
      const school = await prisma.school.findUniqueOrThrow({ where: { id: user.schoolId }, select: { name: true } });
      try {
        const res = await whatsapp.sendTemplate({ to: phone, template: 'schoolap_test', params: [school.name], recipientLabel: user.fullName ?? 'Test' });
        logger.info('Message WhatsApp de test envoyé', { by: user.id, providerId: res.id, at: todayIn(config.timezone) });
        return { test: { status: 'sent', phone, providerId: res.id, message: res.message } };
      } catch (err) {
        return { test: { status: 'failed', phone, error: err.message } };
      }
    },
  };
}
