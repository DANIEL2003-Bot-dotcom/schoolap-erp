/**
 * Modèles de messages WhatsApp (catégorie « Utilité ») soumis à l'approbation de Meta.
 *
 * Meta n'accepte, pour un message envoyé à l'initiative de l'école, qu'un modèle approuvé
 * dont seules les variables {{n}} changent. {{1}} est toujours le nom de l'école ; les autres
 * variables sont fournies par chaque service (absence, résultats, reçu, relance).
 *
 * Règles Meta respectées : le texte ne commence ni ne finit par une variable, les variables
 * sont numérotées dans l'ordre, chaque modèle fournit un exemple pour chaque variable.
 */
export const WHATSAPP_TEMPLATES = Object.freeze({
  schoolap_absence: {
    label: "Alerte d'absence",
    type: 'ABSENCE_ALERT',
    body:
      "Alerte d'absence – {{1}} : votre enfant {{2}} ({{3}}) a été marqué ABSENT le {{4}}. " +
      "Si cette absence n'est pas justifiée, merci de contacter l'école.",
    example: ['Institut Mwanga', 'KAMBALE SYAGHUSWA Moïse', '3e Humanités Commerciale', '12/11/2026'],
  },
  schoolap_resultats: {
    label: 'Alerte résultats scolaires',
    type: 'PERFORMANCE_ALERT',
    body:
      'Alerte résultats – {{1}} : les résultats de votre enfant {{2}} sont en baisse ({{3}}). ' +
      "Merci de rencontrer son titulaire pour l'aider avant la fin de l'année.",
    example: ['Institut Mwanga', 'Moïse KAMBALE', 'Mathématiques 42 %, baisse de 12 points'],
  },
  schoolap_recu: {
    label: 'Reçu de paiement',
    type: 'PAYMENT_RECEIPT',
    body:
      'Reçu de paiement – {{1}} : reçu n° {{2}}, montant {{3}} reçu {{4}} pour {{5}} ({{6}}). ' +
      '{{7}}. Conservez ce message comme preuve de paiement.',
    example: ['Institut Mwanga', '000001/2026-2027', '50,00 $', 'en espèces', 'KAMBALE SYAGHUSWA Moïse', 'Frais scolaires T1', 'Reste à payer : 25,00 $'],
  },
  schoolap_recu_annule: {
    label: 'Annulation de reçu',
    type: 'PAYMENT_RECEIPT',
    body:
      'Annulation de reçu – {{1}} : le reçu n° {{2}} ({{3}}, {{4}}) pour {{5}} a été annulé. ' +
      'Si vous avez bien payé, présentez-vous à la comptabilité avec votre reçu.',
    example: ['Institut Mwanga', '000001/2026-2027', '50,00 $', 'Frais scolaires T1', 'KAMBALE SYAGHUSWA Moïse'],
  },
  schoolap_relance: {
    label: 'Rappel de paiement',
    type: 'FEE_REMINDER',
    body:
      'Rappel de paiement – {{1}} : il reste {{2}} à payer pour {{3}} ({{4}}), échéance du {{5}}. ' +
      'Vous pouvez payer à la comptabilité ou par M-Pesa, Orange Money ou Airtel Money.',
    example: ['Institut Mwanga', '25,00 $', 'KAMBALE SYAGHUSWA Moïse', 'Frais scolaires T1', '03/11/2026'],
  },
  schoolap_test: {
    label: 'Message de test',
    type: null,
    body:
      'Test de connexion – {{1}} : ce numéro WhatsApp recevra désormais les alertes scolaires de vos enfants ' +
      '(absences, résultats, reçus et rappels de paiement).',
    example: ['Institut Mwanga'],
  },
});

export const TEMPLATE_NAMES = Object.freeze(Object.keys(WHATSAPP_TEMPLATES));

/** Meta refuse les retours à la ligne, tabulations et suites de plus de 4 espaces dans une variable. */
export function cleanParam(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text.slice(0, 900) : '—';
}

export function variableCount(name) {
  return (WHATSAPP_TEMPLATES[name].body.match(/\{\{\d+\}\}/g) ?? []).length;
}

/** Texte exact reçu par le tuteur (journal des messages, affichage dans le tableau de bord). */
export function renderTemplate(name, params) {
  const tpl = WHATSAPP_TEMPLATES[name];
  if (!tpl) throw new Error(`Modèle WhatsApp inconnu : ${name}`);
  const expected = variableCount(name);
  if (params.length !== expected) throw new Error(`Le modèle ${name} attend ${expected} variable(s), ${params.length} fournie(s).`);
  return tpl.body.replace(/\{\{(\d+)\}\}/g, (_m, n) => cleanParam(params[Number(n) - 1]));
}

/** Corps de la requête Meta de création d'un modèle (POST /{WABA_ID}/message_templates). */
export function templateCreationPayload(name, language) {
  const tpl = WHATSAPP_TEMPLATES[name];
  return {
    name,
    language,
    category: 'UTILITY',
    components: [{ type: 'BODY', text: tpl.body, example: { body_text: [tpl.example] } }],
  };
}
