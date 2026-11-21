import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import request from 'supertest';
import { SEED_USERS } from '../prisma/seed.js';
import { formatDateFr, todayIn } from '../src/utils/dates.js';
import { studentFullName } from '../src/utils/names.js';
import { WHATSAPP_TEMPLATES, renderTemplate, templateCreationPayload, variableCount } from '../src/services/whatsappTemplates.js';
import { describeMetaError } from '../src/services/whatsapp.js';
import { PASSWORDS, buildApp, createPrisma, resetDatabase, testConfig } from './helpers.js';

const prisma = createPrisma();
const APP_SECRET = 'meta-app-secret-test-0123456789';
const VERIFY_TOKEN = 'verif-webhook-ecole';
const PHONE_ID = '109876543210';
const WABA_ID = '204060801000';

const liveConfig = () =>
  testConfig({
    WHATSAPP_ACCESS_TOKEN: 'EAAG-test-token',
    WHATSAPP_PHONE_NUMBER_ID: PHONE_ID,
    WHATSAPP_BUSINESS_ACCOUNT_ID: WABA_ID,
    WHATSAPP_APP_SECRET: APP_SECRET,
    WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN,
  });

/**
 * Faux serveur Meta : enregistre chaque appel et répond comme l'API Cloud.
 * failFor : numéros (chiffres) pour lesquels l'envoi échoue avec l'erreur Meta donnée.
 */
function fakeMeta() {
  const calls = [];
  const failFor = new Map();
  const remoteTemplates = [{ name: 'schoolap_absence', status: 'APPROVED', language: 'fr', category: 'UTILITY', rejected_reason: 'NONE' }];
  let n = 0;
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method ?? 'GET', body, auth: init.headers?.Authorization });
    const path = new URL(url).pathname;
    if (path.endsWith(`/${PHONE_ID}/messages`)) {
      const err = failFor.get(body.to);
      if (err) return json(400, { error: err });
      n += 1;
      return json(200, { messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.TEST${n}` }] });
    }
    if (path.endsWith(`/${PHONE_ID}`)) {
      return json(200, { display_phone_number: '+243 970 111 222', verified_name: 'Institut Mwanga', quality_rating: 'GREEN', name_status: 'APPROVED', code_verification_status: 'VERIFIED' });
    }
    if (path.endsWith(`/${WABA_ID}/message_templates`) && (init.method ?? 'GET') === 'GET') return json(200, { data: remoteTemplates });
    if (path.endsWith(`/${WABA_ID}/message_templates`)) {
      remoteTemplates.push({ name: body.name, status: 'PENDING', language: body.language, category: body.category, rejected_reason: 'NONE' });
      return json(200, { id: String(1000 + remoteTemplates.length), status: 'PENDING', category: 'UTILITY' });
    }
    return json(404, { error: { code: 100, message: `Chemin inattendu ${path}` } });
  };
  return { calls, failFor, fetchImpl, sends: () => calls.filter((c) => c.url.endsWith(`/${PHONE_ID}/messages`)) };
}

const sign = (raw) => `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
const statusEvent = (statuses, messages = []) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: WABA_ID, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_ID }, statuses, messages } }] }],
});

let ctx;
let meta;
async function login(phone, password) {
  const res = await request(ctx.app).post('/api/auth/login').send({ phone, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const record = (s, date, isPresent) => ({ id: randomUUID(), studentId: s.id, date, isPresent, clientUpdatedAt: new Date().toISOString() });
const postWebhook = (payload, signature) => {
  const raw = JSON.stringify(payload);
  return request(ctx.app).post('/api/whatsapp/webhook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', signature ?? sign(raw)).send(raw);
};

describe('Modèles WhatsApp (règles Meta)', () => {
  test('chaque modèle : texte fixe au début et à la fin, variables numérotées, exemple complet', () => {
    for (const [name, t] of Object.entries(WHATSAPP_TEMPLATES)) {
      assert.match(name, /^[a-z0-9_]+$/, 'nom Meta : minuscules, chiffres, _');
      assert.ok(!/^\{\{/.test(t.body) && !/\}\}$/.test(t.body), `${name} ne commence ni ne finit par une variable`);
      const nums = [...t.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
      assert.deepEqual(nums, nums.map((_, i) => i + 1), `${name} : variables 1..n dans l'ordre`);
      assert.equal(t.example.length, variableCount(name));
      const payload = templateCreationPayload(name, 'fr');
      assert.equal(payload.category, 'UTILITY');
      assert.deepEqual(payload.components[0].example.body_text[0], t.example);
    }
  });

  test('rendu : retours à la ligne retirés des variables, nombre de variables contrôlé', () => {
    const text = renderTemplate('schoolap_absence', ['Institut Mwanga', 'KAMBALE\nMoïse', '5e  Primaire\tA', '12/11/2026']);
    assert.equal(text, "Alerte d'absence – Institut Mwanga : votre enfant KAMBALE Moïse (5e Primaire A) a été marqué ABSENT le 12/11/2026. Si cette absence n'est pas justifiée, merci de contacter l'école.");
    assert.throws(() => renderTemplate('schoolap_absence', ['un']), /attend 4 variable/);
    assert.match(describeMetaError({ code: 131026 }), /sans WhatsApp/);
    assert.equal(describeMetaError({ code: 999, title: 'Erreur X', error_data: { details: 'détail' } }), 'Erreur X — détail (code 999)');
  });
});

describe('WhatsApp non relié', () => {
  before(async () => {
    ctx = buildApp(prisma);
  });
  beforeEach(async () => resetDatabase(prisma));

  test('page Administrateur : mode « off », modèles non reliés ; envoi de test refusé ; webhook non configuré', async () => {
    const admin = await login(SEED_USERS.admin.phone, PASSWORDS.admin);
    const res = await request(ctx.app).get('/api/admin/whatsapp').set(auth(admin));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.whatsapp.mode, 'off');
    assert.ok(res.body.whatsapp.templates.every((t) => t.status === 'NOT_CONNECTED'));
    assert.equal(res.body.whatsapp.guardians.sms, 0);
    assert.ok(res.body.whatsapp.guardians.whatsapp > 0, 'tous les tuteurs acceptent WhatsApp par défaut');
    assert.equal((await request(ctx.app).post('/api/admin/whatsapp/test').set(auth(admin)).send({ phone: '0970000099' })).status, 400);
    assert.equal((await request(ctx.app).post('/api/admin/whatsapp/templates').set(auth(admin))).status, 409);
    assert.equal((await request(ctx.app).get('/api/whatsapp/webhook').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'x', 'hub.challenge': '1' })).status, 409);
  });
});

describe('WhatsApp relié (API Cloud de Meta)', () => {
  before(async () => {
    meta = fakeMeta();
    ctx = buildApp(prisma, { config: liveConfig(), whatsappFetch: meta.fetchImpl });
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    meta.calls.length = 0;
    meta.failFor.clear();
    ctx.printed.length = 0;
  });
  after(async () => prisma.$disconnect());

  test('absence : modèle approuvé envoyé au tuteur sur WhatsApp, aucun SMS, accusés distribué puis lu', async () => {
    const teacher = await login(SEED_USERS.teacher1.phone, PASSWORDS.teacher);
    const cls = await prisma.class.findFirstOrThrow({ where: { name: '5e Primaire A' }, include: { students: { orderBy: { matricule: 'asc' } } } });
    const today = todayIn('Africa/Lubumbashi');
    const absent = cls.students[0];
    const res = await request(ctx.app).post('/api/attendance/sync').set(auth(teacher)).send({ records: [record(absent, today, false)] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.results[0].sms, 'sent');

    const [send] = meta.sends();
    assert.equal(send.auth, 'Bearer EAAG-test-token');
    assert.equal(send.body.to, absent.guardianPhone.replace('+', ''));
    assert.equal(send.body.template.name, 'schoolap_absence');
    assert.equal(send.body.template.language.code, 'fr');
    assert.deepEqual(
      send.body.template.components[0].parameters.map((p) => p.text),
      ['Institut Mwanga', studentFullName(absent), '5e Primaire A', formatDateFr(today)],
    );
    assert.equal(ctx.printed.length, 0, 'aucun SMS envoyé');

    const log = await prisma.smsLog.findFirstOrThrow({ where: { studentId: absent.id, type: 'ABSENCE_ALERT' } });
    assert.equal(log.channel, 'WHATSAPP');
    assert.equal(log.status, 'SENT');
    assert.equal(log.providerId, 'wamid.TEST1');
    assert.match(log.message, /^Alerte d'absence – Institut Mwanga : votre enfant /);

    const ts = Math.floor(Date.now() / 1000);
    assert.equal((await postWebhook(statusEvent([{ id: 'wamid.TEST1', status: 'read', timestamp: String(ts + 5), recipient_id: send.body.to }]))).status, 200);
    // Accusé « distribué » arrivé après « lu » : on ne revient pas en arrière.
    const late = await postWebhook(statusEvent([{ id: 'wamid.TEST1', status: 'delivered', timestamp: String(ts + 2), recipient_id: send.body.to }]));
    assert.equal(late.body.updated, 0);
    const read = await prisma.smsLog.findUniqueOrThrow({ where: { id: log.id } });
    assert.equal(read.status, 'READ');
    assert.ok(read.readAt && read.deliveredAt);

    const director = await login(SEED_USERS.director.phone, PASSWORDS.director);
    const summary = await request(ctx.app).get('/api/dashboard/summary').set(auth(director));
    const row = summary.body.absents.find((a) => a.studentId === absent.id);
    assert.deepEqual({ channel: row.message.channel, status: row.message.status }, { channel: 'WHATSAPP', status: 'READ' });
    assert.equal(summary.body.messages.whatsappMode, 'live');
    assert.equal(summary.body.messages.today.whatsapp.read, 1);
  });

  test('tuteur sans WhatsApp (case décochée) : SMS comme avant', async () => {
    const admin = await login(SEED_USERS.admin.phone, PASSWORDS.admin);
    const cls = await prisma.class.findFirstOrThrow({ where: { name: '5e Primaire A' }, include: { students: { orderBy: { matricule: 'asc' } } } });
    const s = cls.students[1];
    const patch = await request(ctx.app).patch(`/api/admin/students/${s.id}`).set(auth(admin)).send({ guardianWhatsapp: false });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));
    assert.equal(patch.body.student.guardianWhatsapp, false);

    const teacher = await login(SEED_USERS.teacher1.phone, PASSWORDS.teacher);
    await request(ctx.app).post('/api/attendance/sync').set(auth(teacher)).send([record(s, todayIn('Africa/Lubumbashi'), false)]).expect(200);
    assert.equal(meta.sends().length, 0);
    assert.equal(ctx.printed.length, 1, 'SMS envoyé');
    const log = await prisma.smsLog.findFirstOrThrow({ where: { studentId: s.id, type: 'ABSENCE_ALERT' } });
    assert.equal(log.channel, 'SMS');
  });

  test('échec WhatsApp : pas de SMS de secours, échec affiché à la Direction (sans le texte), « Parent appelé » le retire', async () => {
    const cls = await prisma.class.findFirstOrThrow({ where: { name: '5e Primaire A' }, include: { students: { orderBy: { matricule: 'asc' } } } });
    const s = cls.students[2];
    meta.failFor.set(s.guardianPhone.replace('+', ''), { code: 131026, title: 'Message undeliverable', message: 'Message undeliverable' });
    const teacher = await login(SEED_USERS.teacher1.phone, PASSWORDS.teacher);
    const today = todayIn('Africa/Lubumbashi');
    const res = await request(ctx.app).post('/api/attendance/sync').set(auth(teacher)).send([record(s, today, false)]);
    assert.equal(res.body.results[0].sms, 'failed');
    assert.equal(ctx.printed.length, 0, 'aucun SMS de secours');
    const att = await prisma.attendance.findFirstOrThrow({ where: { studentId: s.id, date: new Date(`${today}T00:00:00Z`) } });
    assert.ok(att.smsAlertSentAt, 'pas de nouvel essai automatique');

    const director = await login(SEED_USERS.director.phone, PASSWORDS.director);
    const summary = await request(ctx.app).get('/api/dashboard/summary').set(auth(director));
    const failure = summary.body.messages.failures.find((f) => f.studentId === s.id);
    assert.ok(failure, JSON.stringify(summary.body.messages));
    assert.equal(failure.typeLabel, "Alerte d'absence");
    assert.equal(failure.guardianPhone, s.guardianPhone);
    assert.match(failure.error, /sans WhatsApp/);
    assert.equal(failure.message, undefined, 'le texte (parfois avec montants) n’est pas transmis');
    assert.equal(summary.body.absents.find((a) => a.studentId === s.id).message.status, 'FAILED');

    const handled = await request(ctx.app).post(`/api/dashboard/messages/${failure.id}/handled`).set(auth(director));
    assert.equal(handled.status, 200, JSON.stringify(handled.body));
    const after = await request(ctx.app).get('/api/dashboard/summary').set(auth(director));
    assert.equal(after.body.messages.failures.some((f) => f.id === failure.id), false);
  });

  test('échec signalé plus tard par le webhook (téléphone éteint plusieurs jours)', async () => {
    const teacher = await login(SEED_USERS.teacher1.phone, PASSWORDS.teacher);
    const cls = await prisma.class.findFirstOrThrow({ where: { name: '5e Primaire A' }, include: { students: { orderBy: { matricule: 'asc' } } } });
    await request(ctx.app).post('/api/attendance/sync').set(auth(teacher)).send([record(cls.students[3], todayIn('Africa/Lubumbashi'), false)]).expect(200);
    const log = await prisma.smsLog.findFirstOrThrow({ where: { studentId: cls.students[3].id } });
    const res = await postWebhook(statusEvent([{ id: log.providerId, status: 'failed', timestamp: String(Math.floor(Date.now() / 1000)), errors: [{ code: 131049, title: 'Not delivered' }] }]));
    assert.equal(res.body.updated, 1);
    const failed = await prisma.smsLog.findUniqueOrThrow({ where: { id: log.id } });
    assert.equal(failed.status, 'FAILED');
    assert.match(failed.error, /ne pas distribuer/);
  });

  test('webhook : vérification Meta, signature obligatoire, « STOP » désinscrit le tuteur', async () => {
    const ok = await request(ctx.app).get('/api/whatsapp/webhook').query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '8812' });
    assert.equal(ok.status, 200);
    assert.equal(ok.text, '8812');
    assert.equal((await request(ctx.app).get('/api/whatsapp/webhook').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'faux', 'hub.challenge': '1' })).status, 403);
    assert.equal((await postWebhook(statusEvent([]), 'sha256=00')).status, 403);
    assert.equal((await request(ctx.app).post('/api/whatsapp/webhook').set('Content-Type', 'application/json').send('{}')).status, 403);

    const s = await prisma.student.findFirstOrThrow({ where: { isActive: true }, orderBy: { matricule: 'asc' } });
    const siblings = await prisma.student.count({ where: { guardianPhone: s.guardianPhone } });
    const stop = await postWebhook(statusEvent([], [{ from: s.guardianPhone.replace('+', ''), id: 'wamid.IN1', type: 'text', text: { body: ' Arrêt ' } }]));
    assert.equal(stop.status, 200);
    assert.equal(stop.body.optOuts, siblings);
    assert.equal((await prisma.student.findUniqueOrThrow({ where: { id: s.id } })).guardianWhatsapp, false);
  });

  test('caisse : reçu WhatsApp au tuteur ; rappel non distribué → le délai de 24 h est libéré', async () => {
    const bursar = await login(SEED_USERS.bursar.phone, PASSWORDS.bursar);
    const fee = await prisma.schoolFee.findFirstOrThrow({ where: { status: 'INSOLVABLE' }, include: { student: true }, orderBy: { id: 'asc' } });
    const pay = await request(ctx.app).post('/api/finance/payments').set(auth(bursar)).send({ clientRequestId: randomUUID(), schoolFeeId: fee.id, amount: 5, method: 'CASH' });
    assert.equal(pay.status, 201, JSON.stringify(pay.body));
    assert.equal(pay.body.sms.channel, 'WHATSAPP');
    assert.equal(pay.body.sms.status, 'sent');
    const recu = meta.sends().at(-1);
    assert.equal(recu.body.template.name, 'schoolap_recu');
    const params = recu.body.template.components[0].parameters.map((p) => p.text);
    assert.equal(params[1], pay.body.receipt.receiptNumber);
    assert.equal(params[3], 'en espèces');
    assert.match(params[6], /^Reste à payer : /);

    meta.failFor.set(fee.student.guardianPhone.replace('+', ''), { code: 131026, title: 'Message undeliverable' });
    const remind = await request(ctx.app).post(`/api/fees/${fee.id}/remind`).set(auth(bursar));
    assert.equal(remind.status, 200, JSON.stringify(remind.body));
    assert.equal(remind.body.sms.status, 'failed');
    assert.equal(remind.body.remindedAt, null);
    meta.failFor.clear();
    const again = await request(ctx.app).post(`/api/fees/${fee.id}/remind`).set(auth(bursar));
    assert.equal(again.status, 200, 'nouvelle relance possible tout de suite');
    assert.equal(again.body.sms.status, 'sent');
    assert.equal(meta.sends().at(-1).body.template.name, 'schoolap_relance');
    assert.equal((await request(ctx.app).post(`/api/fees/${fee.id}/remind`).set(auth(bursar))).status, 429);
  });

  test('page Administrateur : numéro, état des modèles, soumission des modèles manquants, test ; réservée à l’Administrateur', async () => {
    const director = await login(SEED_USERS.director.phone, PASSWORDS.director);
    assert.equal((await request(ctx.app).get('/api/admin/whatsapp').set(auth(director))).status, 403);
    const bursar = await login(SEED_USERS.bursar.phone, PASSWORDS.bursar);
    assert.equal((await request(ctx.app).post('/api/admin/whatsapp/test').set(auth(bursar)).send({ phone: '0970000099' })).status, 403);

    const admin = await login(SEED_USERS.admin.phone, PASSWORDS.admin);
    const st = await request(ctx.app).get('/api/admin/whatsapp').set(auth(admin));
    assert.equal(st.status, 200, JSON.stringify(st.body));
    assert.equal(st.body.whatsapp.mode, 'live');
    assert.equal(st.body.whatsapp.phone.verifiedName, 'Institut Mwanga');
    const byName = Object.fromEntries(st.body.whatsapp.templates.map((t) => [t.name, t.status]));
    assert.equal(byName.schoolap_absence, 'APPROVED');
    assert.equal(byName.schoolap_recu, 'MISSING');
    assert.equal(JSON.stringify(st.body).includes('EAAG-test-token'), false, 'le jeton n’est jamais renvoyé');

    const sub = await request(ctx.app).post('/api/admin/whatsapp/templates').set(auth(admin));
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    assert.equal(sub.body.submitted.length, Object.keys(WHATSAPP_TEMPLATES).length - 1, 'le modèle déjà approuvé n’est pas resoumis');
    assert.ok(sub.body.submitted.every((t) => t.submitted && t.status === 'PENDING'));
    const created = meta.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/message_templates'));
    assert.equal(created[0].body.category, 'UTILITY');
    assert.ok(sub.body.templates.every((t) => t.status !== 'MISSING'));

    const test1 = await request(ctx.app).post('/api/admin/whatsapp/test').set(auth(admin)).send({ phone: '0970 000 099' });
    assert.equal(test1.status, 200, JSON.stringify(test1.body));
    assert.equal(test1.body.test.status, 'sent');
    assert.equal(meta.sends().at(-1).body.to, '243970000099');
    assert.equal((await request(ctx.app).post('/api/admin/whatsapp/test').set(auth(admin)).send({ phone: '12' })).status, 400);
  });
});
