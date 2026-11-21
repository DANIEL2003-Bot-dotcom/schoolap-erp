import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { HttpError, forbidden } from '../utils/httpError.js';
import { formatDateTimeFr } from '../utils/dates.js';
import { formatPhone } from '../utils/phone.js';
import { logger } from '../utils/logger.js';
import { TEMPLATE_NAMES, WHATSAPP_TEMPLATES, cleanParam, renderTemplate, templateCreationPayload } from './whatsappTemplates.js';

const GRAPH = 'https://graph.facebook.com';
const TIMEOUT_MS = 10_000;

/** Motifs d'échec Meta les plus fréquents, traduits pour l'école. */
const META_ERRORS = {
  190: "Jeton d'accès WhatsApp expiré ou invalide : l'Administrateur doit le renouveler.",
  368: 'Compte WhatsApp Business temporairement bloqué par Meta.',
  131000: 'Erreur temporaire de WhatsApp.',
  131005: "Le jeton d'accès n'a pas la permission d'envoyer des messages WhatsApp.",
  131008: 'Variable de message manquante.',
  131009: 'Variable de message invalide.',
  131021: "Le numéro du tuteur est celui de l'école.",
  131026: "Numéro sans WhatsApp ou téléphone du tuteur injoignable : prévenez-le par téléphone.",
  131030: "Numéro non autorisé : le compte WhatsApp de l'école est encore en mode test.",
  131031: 'Compte WhatsApp Business restreint par Meta.',
  131042: 'Problème de paiement du compte WhatsApp Business (moyen de paiement à vérifier chez Meta).',
  131045: "Numéro WhatsApp de l'école non enregistré.",
  131047: "Délai de 24 h dépassé : seul un modèle approuvé peut être envoyé.",
  131049: 'Meta a choisi de ne pas distribuer ce message (trop de messages récents à ce tuteur).',
  131050: "Le tuteur a bloqué les messages de l'école sur WhatsApp.",
  131051: 'Type de message non pris en charge.',
  131053: 'Fichier joint refusé par WhatsApp.',
  131056: 'Trop de messages envoyés au même tuteur en peu de temps.',
  130429: "Limite d'envoi WhatsApp atteinte : réessayez plus tard.",
  131048: "Limite d'envoi atteinte (qualité du numéro de l'école).",
  132000: 'Nombre de variables différent du modèle approuvé.',
  132001: "Modèle de message absent ou pas encore approuvé par Meta.",
  132005: 'Message trop long pour le modèle.',
  132007: 'Contenu refusé par la politique de Meta.',
  132012: 'Format de variable refusé par le modèle.',
  132015: 'Modèle de message suspendu par Meta (qualité insuffisante).',
  132016: 'Modèle de message désactivé par Meta.',
  133010: "Numéro WhatsApp de l'école non enregistré auprès de Meta.",
};

export class WhatsAppError extends Error {
  constructor(message, { code = null, details = null } = {}) {
    super(message);
    this.name = 'WhatsAppError';
    this.code = code;
    this.details = details;
  }
}

/** Traduit une erreur Meta ({ code, title, message, error_data.details }) en motif lisible. */
export function describeMetaError(err) {
  if (!err) return 'Erreur WhatsApp inconnue.';
  const code = Number(err.code);
  if (META_ERRORS[code]) return META_ERRORS[code];
  const details = err.error_data?.details ?? err.details;
  const base = err.title || err.message || 'Erreur WhatsApp';
  return `${base}${details && details !== base ? ` — ${details}` : ''}${code ? ` (code ${code})` : ''}`;
}

/** Numéro E.164 (+243…) → format attendu par Meta (chiffres uniquement). */
export const toWaId = (e164) => String(e164).replace(/\D/g, '');

const STATUS_MAP = { sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' };
const STATUS_RANK = { SENT: 1, DELIVERED: 2, READ: 3 };
const STOP_WORDS = new Set(['STOP', 'ARRET', 'ARRETER', 'DESABONNER', 'DESINSCRIRE', 'UNSUBSCRIBE']);

export function verifyMetaSignature(rawBody, header, appSecret) {
  if (!appSecret || !header || !rawBody) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`);
  const received = Buffer.from(String(header));
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/**
 * Connexion à l'API Cloud de WhatsApp (Meta) :
 *  - envoi des modèles approuvés aux tuteurs ;
 *  - lecture de l'état du numéro et des modèles, soumission des modèles manquants ;
 *  - traitement du webhook : accusés de réception / lecture / échec et désinscription « STOP ».
 */
export function createWhatsAppService({ prisma, config, fetchImpl = globalThis.fetch, print = console.log }) {
  const wa = config.whatsapp;
  const base = `${GRAPH}/${wa.apiVersion}`;

  async function graph(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${wa.accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new WhatsAppError(err.name === 'TimeoutError' ? 'WhatsApp ne répond pas (délai dépassé).' : `WhatsApp injoignable : ${err.message}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      throw new WhatsAppError(describeMetaError(data.error ?? { message: `HTTP ${res.status}` }), { code: data.error?.code ?? res.status, details: data.error ?? null });
    }
    return data;
  }

  function requireLive() {
    if (wa.mode !== 'live') throw new HttpError(409, 'WHATSAPP_NOT_CONFIGURED', 'WhatsApp n’est pas encore relié : renseignez le jeton d’accès et l’identifiant du numéro sur le serveur.');
  }
  function requireAccount() {
    requireLive();
    if (!wa.businessAccountId) throw new HttpError(409, 'WHATSAPP_NOT_CONFIGURED', 'Identifiant du compte WhatsApp Business (WHATSAPP_BUSINESS_ACCOUNT_ID) manquant sur le serveur.');
  }

  return {
    mode: wa.mode,
    isActive: wa.mode !== 'off',
    render: renderTemplate,

    /** Envoie un modèle approuvé. Retourne { id: wamid, message: texte reçu par le tuteur }. */
    async sendTemplate({ to, template, params, recipientLabel = 'Tuteur', type = null }) {
      const message = renderTemplate(template, params);
      if (wa.mode === 'simulation') {
        const id = `wamid.SIMU-${randomUUID().slice(0, 12).toUpperCase()}`;
        const line = '═'.repeat(64);
        print(
          [
            `╔${line}`,
            '║ 💬 WHATSAPP BUSINESS — ENVOI AUTOMATISÉ (SIMULATION)',
            `╠${line}`,
            `║ Modèle       : ${template} (${WHATSAPP_TEMPLATES[template].label}${type ? ` · ${type}` : ''})`,
            `║ Destinataire : ${formatPhone(to)} (${recipientLabel})`,
            `║ Horodatage   : ${formatDateTimeFr(new Date(), config.timezone)} (${config.timezone})`,
            `║ Message      : ${message}`,
            `║ Statut       : ✅ ACCEPTÉ PAR WHATSAPP — ID ${id}`,
            `╚${line}`,
          ].join('\n'),
        );
        return { id, message };
      }
      requireLive();
      const data = await graph(`/${wa.phoneNumberId}/messages`, {
        method: 'POST',
        body: {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: toWaId(to),
          type: 'template',
          template: {
            name: template,
            language: { code: wa.language },
            components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: cleanParam(p) })) }],
          },
        },
      });
      const id = data.messages?.[0]?.id;
      if (!id) throw new WhatsAppError('Réponse WhatsApp sans identifiant de message.');
      return { id, message };
    },

    /** Numéro de l'école : nom affiché, qualité, état de vérification. */
    async phoneInfo() {
      requireLive();
      const p = await graph(`/${wa.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,name_status,code_verification_status,messaging_limit_tier`);
      return {
        displayPhoneNumber: p.display_phone_number ?? null,
        verifiedName: p.verified_name ?? null,
        qualityRating: p.quality_rating ?? null,
        nameStatus: p.name_status ?? null,
        verificationStatus: p.code_verification_status ?? null,
        messagingLimit: p.messaging_limit_tier ?? null,
      };
    },

    /** État des modèles de l'application chez Meta (APPROVED, PENDING, REJECTED, MISSING…). */
    async templatesStatus() {
      requireAccount();
      const data = await graph(`/${wa.businessAccountId}/message_templates?fields=name,status,language,category,rejected_reason&limit=200`);
      const remote = (data.data ?? []).filter((t) => t.language === wa.language || t.language?.startsWith(`${wa.language}_`));
      return TEMPLATE_NAMES.map((name) => {
        const r = remote.find((t) => t.name === name);
        return {
          name,
          label: WHATSAPP_TEMPLATES[name].label,
          body: WHATSAPP_TEMPLATES[name].body,
          status: r?.status ?? 'MISSING',
          category: r?.category ?? null,
          rejectedReason: r?.rejected_reason && r.rejected_reason !== 'NONE' ? r.rejected_reason : null,
        };
      });
    },

    /** Soumet à Meta les modèles absents (ou refusés puis supprimés). Les modèles existants ne sont pas touchés. */
    async submitMissingTemplates() {
      const current = await this.templatesStatus();
      const results = [];
      for (const t of current.filter((x) => x.status === 'MISSING')) {
        try {
          const r = await graph(`/${wa.businessAccountId}/message_templates`, { method: 'POST', body: templateCreationPayload(t.name, wa.language) });
          results.push({ name: t.name, label: t.label, submitted: true, status: r.status ?? 'PENDING', category: r.category ?? 'UTILITY' });
        } catch (err) {
          results.push({ name: t.name, label: t.label, submitted: false, error: err.message });
        }
      }
      return { submitted: results, templates: await this.templatesStatus() };
    },

    verifyChallenge(query) {
      if (!wa.verifyToken) throw new HttpError(409, 'WHATSAPP_NOT_CONFIGURED', 'Jeton de vérification du webhook (WHATSAPP_VERIFY_TOKEN) non configuré.');
      if (query['hub.mode'] !== 'subscribe' || query['hub.verify_token'] !== wa.verifyToken) throw forbidden('Jeton de vérification du webhook incorrect.');
      return String(query['hub.challenge'] ?? '');
    },

    /** Notifications Meta : accusés (sent → delivered → read, ou failed) et messages entrants « STOP ». */
    async handleWebhook(rawBody, signature) {
      if (!wa.appSecret) throw new HttpError(409, 'WHATSAPP_NOT_CONFIGURED', 'Clé secrète de l’application Meta (WHATSAPP_APP_SECRET) non configurée.');
      if (!verifyMetaSignature(rawBody, signature, wa.appSecret)) throw forbidden('Signature du webhook WhatsApp invalide.');
      let payload;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Corps JSON invalide.');
      }
      const stats = { statuses: 0, updated: 0, optOuts: 0 };
      for (const entry of payload.entry ?? []) {
        for (const change of entry.changes ?? []) {
          const value = change.value ?? {};
          for (const st of value.statuses ?? []) {
            stats.statuses++;
            if (await applyStatus(st)) stats.updated++;
          }
          for (const msg of value.messages ?? []) {
            const text = (msg.text?.body ?? msg.button?.text ?? '').normalize('NFD').replace(/\p{M}/gu, '').trim().toUpperCase();
            if (!STOP_WORDS.has(text)) continue;
            const phone = `+${toWaId(msg.from)}`;
            const r = await prisma.student.updateMany({ where: { guardianPhone: phone, guardianWhatsapp: true }, data: { guardianWhatsapp: false } });
            if (r.count > 0) {
              stats.optOuts += r.count;
              logger.info('Tuteur désinscrit de WhatsApp (STOP)', { phone: phone.slice(0, -4) + '****', students: r.count });
            }
          }
        }
      }
      return stats;
    },
  };

  async function applyStatus(st) {
    const next = STATUS_MAP[st.status];
    if (!next || !st.id) return false;
    const log = await prisma.smsLog.findFirst({ where: { providerId: st.id, channel: 'WHATSAPP' } });
    if (!log) return false;
    const at = st.timestamp ? new Date(Number(st.timestamp) * 1000) : new Date();
    if (next === 'FAILED') {
      if (log.status === 'FAILED') return false;
      const error = describeMetaError(st.errors?.[0]);
      await prisma.smsLog.update({ where: { id: log.id }, data: { status: 'FAILED', error } });
      logger.warn('Message WhatsApp non distribué', { logId: log.id, type: log.type, error });
      return true;
    }
    // Les accusés peuvent arriver dans le désordre : on ne revient jamais en arrière (lu → distribué).
    if (log.status === 'FAILED' || (STATUS_RANK[log.status] ?? 0) >= STATUS_RANK[next]) return false;
    await prisma.smsLog.update({
      where: { id: log.id },
      data: {
        status: next,
        ...(next !== 'SENT' && !log.deliveredAt ? { deliveredAt: at } : {}),
        ...(next === 'READ' ? { readAt: at } : {}),
      },
    });
    return true;
  }
}
