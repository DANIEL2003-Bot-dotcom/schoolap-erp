import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import request from 'supertest';
import { SEED_USERS } from '../prisma/seed.js';
import { signWebhook } from '../src/services/mobileMoney.js';
import { amountToWordsFr, integerToWordsFr } from '../src/utils/amountWords.js';
import { schoolYearOf, todayIn } from '../src/utils/dates.js';
import { PASSWORDS, buildApp, createPrisma, resetDatabase } from './helpers.js';

const prisma = createPrisma();
let ctx;
let director;
let admin;
let bursar;

async function login(phone, password) {
  const res = await request(ctx.app).post('/api/auth/login').send({ phone, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const api = (method, path, token = bursar) => request(ctx.app)[method](path).set(auth(token));
const year = () => schoolYearOf(todayIn(ctx.config.timezone));
const today = () => todayIn(ctx.config.timezone);

/** Frais impayé (rien versé) d'un élève de la base de démonstration. */
async function unpaidFee(extra = {}) {
  return prisma.schoolFee.findFirstOrThrow({ where: { amountPaid: 0, status: { not: 'SOLDE' }, ...extra }, include: { student: true }, orderBy: { id: 'asc' } });
}
const pay = (fee, body = {}, token = bursar) =>
  api('post', '/api/finance/payments', token).send({ clientRequestId: randomUUID(), schoolFeeId: fee.id, amount: 10, method: 'CASH', ...body });

before(() => prisma.$connect());
after(() => prisma.$disconnect());
beforeEach(async () => {
  await resetDatabase(prisma);
  ctx = buildApp(prisma);
  director = await login(SEED_USERS.director.phone, PASSWORDS.director);
  bursar = await login(SEED_USERS.bursar.phone, PASSWORDS.bursar);
  admin = await login(SEED_USERS.admin.phone, PASSWORDS.admin);
});

describe('Montant en toutes lettres', () => {
  test('règles du français : vingt et un, quatre-vingts, deux cents, mille invariable, million de', () => {
    assert.equal(integerToWordsFr(21), 'vingt et un');
    assert.equal(integerToWordsFr(71), 'soixante et onze');
    assert.equal(integerToWordsFr(80), 'quatre-vingts');
    assert.equal(integerToWordsFr(81), 'quatre-vingt-un');
    assert.equal(integerToWordsFr(99), 'quatre-vingt-dix-neuf');
    assert.equal(integerToWordsFr(200), 'deux cents');
    assert.equal(integerToWordsFr(201), 'deux cent un');
    assert.equal(integerToWordsFr(80_000), 'quatre-vingt mille');
    assert.equal(integerToWordsFr(200_000), 'deux cent mille');
    assert.equal(integerToWordsFr(1_234_567), 'un million deux cent trente-quatre mille cinq cent soixante-sept');
    assert.equal(amountToWordsFr(1, 'USD'), 'un dollar américain');
    assert.equal(amountToWordsFr(45.5, 'USD'), 'quarante-cinq dollars américains et cinquante cents');
    assert.equal(amountToWordsFr(150_000, 'CDF'), 'cent cinquante mille francs congolais');
    assert.equal(amountToWordsFr(1_000_000, 'CDF'), 'un million de francs congolais');
  });
});

describe('Droits du comptable', () => {
  test('gère les frais avec l’administrateur ; la direction ne crée, ne modifie ni n’encaisse plus rien', async () => {
    const cls = await prisma.class.findFirstOrThrow({ where: { name: '5e Primaire A' } });
    const body = { classIds: [cls.id], feeType: 'AUTRE', label: 'Excursion', amountDue: 15, currency: 'USD', dueDate: '2027-03-01' };
    const fee = await unpaidFee();
    assert.equal((await api('post', '/api/admin/fees/bulk', director).send(body)).status, 403);
    assert.equal((await api('patch', `/api/admin/fees/${fee.id}`, director).send({ amountDue: 1 })).status, 403, 'pas de remise par la direction');
    assert.equal(Number((await prisma.schoolFee.findUniqueOrThrow({ where: { id: fee.id } })).amountDue), Number(fee.amountDue));
    assert.equal((await pay(fee, {}, director)).status, 403, 'la direction n’encaisse pas');
    assert.equal((await api('get', '/api/finance/payments', director)).status, 403, 'ni journal de caisse');
    assert.equal((await api('get', `/api/finance/summary`, director)).status, 403);

    assert.equal((await api('post', '/api/admin/fees/bulk').send(body)).status, 201);
    assert.equal((await api('patch', `/api/admin/fees/${fee.id}`).send({ dueDate: '2027-06-30' })).status, 200);
    const other = { ...body, label: 'Uniforme' };
    assert.equal((await api('post', '/api/admin/fees/bulk', admin).send(other)).status, 201);
  });

  test('voit les finances, pas la vie scolaire (présences, résultats, alertes, personnel)', async () => {
    const summary = await api('get', '/api/dashboard/summary');
    assert.equal(summary.status, 200);
    assert.deepEqual(summary.body.access, { academic: false, cashier: true, amounts: true });
    assert.equal(summary.body.attendance, null);
    assert.deepEqual(summary.body.absents, []);
    assert.equal(summary.body.performanceAlerts, null);
    assert.ok(summary.body.insolvents.length > 0, 'les insolvables restent visibles');
    assert.ok(Array.isArray(summary.body.finance));
    assert.equal(typeof summary.body.cash.count, 'number');

    assert.equal((await api('get', '/api/dashboard/performance-alerts')).status, 403);
    const overview = await api('get', '/api/admin/overview');
    assert.equal(overview.status, 200);
    assert.deepEqual(overview.body.staff, [], 'pas de liste du personnel ni de téléphones');
    assert.ok(overview.body.classes.length > 0, 'les classes restent disponibles pour les inscriptions');

    const fee = await unpaidFee();
    const detail = await api('get', `/api/admin/students/${fee.studentId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.attendance, null);
    assert.equal(detail.body.performance, null);
    assert.ok(detail.body.fees.length > 0);

    assert.ok(Array.isArray(detail.body.transactions), "la comptabilité voit les paiements");

    // La direction garde la vie scolaire, mais sans montant.
    const full = await api('get', `/api/admin/students/${fee.studentId}`, director);
    assert.notEqual(full.body.attendance, null);
    assert.notEqual(full.body.performance, null);
    assert.equal(full.body.transactions, null);
    const dirSummary = await api('get', '/api/dashboard/summary', director);
    assert.deepEqual(dirSummary.body.access, { academic: true, cashier: false, amounts: false });
    assert.notEqual(dirSummary.body.attendance, null);
    assert.equal(dirSummary.body.cash, null);
    // L'administrateur voit tout.
    const adminSummary = await api('get', '/api/dashboard/summary', admin);
    assert.deepEqual(adminSummary.body.access, { academic: true, cashier: true, amounts: true });
  });

  test('peut encore inscrire des élèves et relancer, pas les enseignants ni le D.E. à la caisse', async () => {
    const cls = await prisma.class.findFirstOrThrow({ where: { name: '5e Primaire A' } });
    const created = await api('post', '/api/admin/students').send({ classId: cls.id, lastName: 'Sikuli', middleName: 'Kambere', firstName: 'Ruth', gender: 'F', guardianPhone: '0891112233' });
    assert.equal(created.status, 201);
    const insolvent = await prisma.schoolFee.findFirstOrThrow({ where: { status: 'INSOLVABLE' } });
    assert.equal((await api('post', `/api/fees/${insolvent.id}/remind`)).status, 200);

    const teacher = await login(SEED_USERS.teacher1.phone, PASSWORDS.teacher);
    assert.equal((await api('get', '/api/finance/payments', teacher)).status, 403);
    await api('post', '/api/admin/users', director).send({ fullName: 'D.E. test', phone: '0970000061', role: 'DIRECTEUR_ETUDES', password: 'Ecole2026x' }).expect(201);
    const de = await login('0970000061', 'Ecole2026x');
    assert.equal((await pay(await unpaidFee(), {}, de)).status, 403);
    assert.equal((await request(ctx.app).get('/api/finance/payments')).status, 401);
  });
});

describe('Encaissement manuel et reçu', () => {
  test('espèces : reçu n° 000001, montant en lettres, frais mis à jour, SMS au tuteur', async () => {
    const fee = await unpaidFee();
    const res = await pay(fee, { amount: 25, payerName: 'Maman Kahindo', note: 'Première tranche' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const r = res.body.receipt;
    assert.equal(r.receiptNumber, `000001/${year()}`);
    assert.equal(r.status, 'SUCCESS');
    assert.equal(r.method, 'CASH');
    assert.equal(r.methodDetails, 'Espèces');
    assert.equal(r.amount, 25);
    assert.equal(r.amountInWords, 'vingt-cinq dollars américains');
    assert.equal(r.fee.balanceAfter, Number(fee.amountDue) - 25);
    assert.equal(r.fee.paidBefore, 0);
    assert.equal(r.cashier.name, SEED_USERS.bursar.fullName);
    assert.equal(r.cashier.role, 'Comptable');
    assert.equal(r.payerName, 'Maman Kahindo');
    assert.equal(r.school.name, 'Institut Mwanga');
    assert.equal(r.student.matricule, fee.student.matricule);
    assert.equal(r.printCount, 0);

    const updated = await prisma.schoolFee.findUniqueOrThrow({ where: { id: fee.id } });
    assert.equal(Number(updated.amountPaid), 25);
    assert.equal(res.body.sms.status, 'sent');
    assert.match(res.body.sms.message, new RegExp(`Recu Ecole n\\. 000001/${year()} : 25\\.00 USD recu en especes`));
    assert.match(res.body.sms.message, /Reste a payer/);

    const second = await pay(await unpaidFee({ id: { not: fee.id } }), { amount: 5 });
    assert.equal(second.body.receipt.receiptNumber, `000002/${year()}`, 'numérotation continue');
  });

  test('double clic : la même requête rejouée renvoie le même reçu sans double encaissement', async () => {
    const fee = await unpaidFee();
    const clientRequestId = randomUUID();
    const first = await pay(fee, { clientRequestId, amount: 10 });
    const again = await pay(fee, { clientRequestId, amount: 10 });
    assert.equal(first.status, 201);
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.receipt.id, first.body.receipt.id);
    assert.equal(Number((await prisma.schoolFee.findUniqueOrThrow({ where: { id: fee.id } })).amountPaid), 10);
    assert.equal(await prisma.transaction.count({ where: { schoolFeeId: fee.id } }), 1);
  });

  test('montant contrôlé : jamais plus que le reste à payer, frais soldé refusé', async () => {
    const fee = await unpaidFee();
    const tooMuch = await pay(fee, { amount: Number(fee.amountDue) + 1 });
    assert.equal(tooMuch.status, 400);
    assert.match(tooMuch.body.error.message, /dépasse le reste à payer/);
    assert.equal((await pay(fee, { amount: 0 })).status, 400);
    assert.equal((await pay(fee, { amount: 1.555 })).status, 400);
    const full = await pay(fee, { amount: Number(fee.amountDue) });
    assert.equal(full.status, 201);
    assert.equal(full.body.receipt.fee.balanceAfter, 0);
    assert.match(full.body.sms.message, /Frais solde\. Merci\./);
    assert.equal((await prisma.schoolFee.findUniqueOrThrow({ where: { id: fee.id } })).status, 'SOLDE');
    assert.equal((await pay(fee, { amount: 1 })).status, 409);
  });

  test('deux caisses encaissent le même solde au même moment : un seul passe, numéros sans trou', async () => {
    const fee = await unpaidFee();
    const amount = Number(fee.amountDue);
    const [a, b] = await Promise.all([pay(fee, { amount }), pay(fee, { amount }, admin)]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    assert.equal(Number((await prisma.schoolFee.findUniqueOrThrow({ where: { id: fee.id } })).amountPaid), amount);
    const next = await pay(await unpaidFee({ id: { not: fee.id } }), { amount: 1 });
    assert.equal(next.body.receipt.receiptNumber, `000002/${year()}`, 'le paiement refusé ne consomme pas de numéro');
  });

  test('banque : banque et bordereau obligatoires, un bordereau ne sert qu’une fois', async () => {
    const fee = await unpaidFee();
    const missing = await pay(fee, { method: 'BANK' });
    assert.equal(missing.status, 400);
    assert.deepEqual(missing.body.error.details.map((d) => d.field).sort(), ['bankName', 'externalRef']);
    const ok = await pay(fee, { method: 'BANK', bankName: 'Rawbank', externalRef: 'bd 004521', payerName: 'Papa Mumbere' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.receipt.externalRef, 'BD004521');
    assert.equal(ok.body.receipt.methodDetails, 'Dépôt bancaire · Rawbank · bordereau n° BD004521');
    assert.match(ok.body.sms.message, /par depot bancaire \(Rawbank, bordereau BD004521\)/);
    const dup = await pay(await unpaidFee({ id: { not: fee.id } }), { method: 'BANK', bankName: 'RAWBANK', externalRef: 'BD004521' });
    assert.equal(dup.status, 409);
    assert.match(dup.body.error.message, /déjà été enregistré \(reçu n° 000001/);
  });

  test('Mobile Money reçu sur le téléphone de l’école : opérateur et référence, numéro cohérent', async () => {
    const fee = await unpaidFee();
    const missing = await pay(fee, { method: 'MOBILE_MONEY_DIRECT' });
    assert.deepEqual(missing.body.error.details.map((d) => d.field).sort(), ['externalRef', 'operator']);
    const wrongOp = await pay(fee, { method: 'MOBILE_MONEY_DIRECT', operator: 'MPESA', externalRef: 'MP260001', payerPhone: '0991234567' });
    assert.equal(wrongOp.status, 400);
    assert.match(wrongOp.body.error.message, /Airtel Money, pas M-Pesa/);
    const ok = await pay(fee, { method: 'MOBILE_MONEY_DIRECT', operator: 'MPESA', externalRef: 'MP260001', payerPhone: '0811234567' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.receipt.payerPhone, '+243811234567');
    assert.equal(ok.body.receipt.methodDetails, 'M-Pesa (téléphone de l’école) · réf. MP260001');
    const dup = await pay(await unpaidFee({ id: { not: fee.id } }), { method: 'MOBILE_MONEY_DIRECT', operator: 'MPESA', externalRef: 'mp260001' });
    assert.equal(dup.status, 409);
  });

  test('impression : l’original puis des duplicatas', async () => {
    const { body } = await pay(await unpaidFee());
    const id = body.receipt.id;
    const first = await api('post', `/api/finance/receipts/${id}/printed`);
    assert.deepEqual([first.body.printCount, first.body.duplicate], [1, false]);
    const second = await api('post', `/api/finance/receipts/${id}/printed`);
    assert.deepEqual([second.body.printCount, second.body.duplicate], [2, true]);
    const receipt = await api('get', `/api/finance/receipts/${id}`);
    assert.equal(receipt.body.receipt.printCount, 2);
    assert.equal((await api('get', `/api/finance/receipts/${randomUUID()}`)).status, 404);
  });

  test('fiche élève : historique avec mode, numéro de reçu et caissier', async () => {
    const fee = await unpaidFee();
    await pay(fee, { method: 'BANK', bankName: 'Equity BCDC', externalRef: 'EQ-77' });
    const detail = await api('get', `/api/admin/students/${fee.studentId}`);
    const row = detail.body.transactions.find((t) => t.method === 'BANK');
    assert.equal(row.receiptNumber, `000001/${year()}`);
    assert.equal(row.cashier, SEED_USERS.bursar.fullName);
    assert.equal(row.feeLabel, fee.label);
    assert.equal(row.methodLabel, 'Banque');
  });
});

describe('Journal de caisse et annulation', () => {
  test('journal du jour : totaux par devise, mode et caissier', async () => {
    const f1 = await unpaidFee();
    const f2 = await unpaidFee({ id: { not: f1.id } });
    await pay(f1, { amount: 20 });
    await pay(f2, { amount: 15, method: 'BANK', bankName: 'TMB', externalRef: 'T-1' }, admin);
    const j = await api('get', `/api/finance/payments?from=${today()}&to=${today()}`);
    assert.equal(j.status, 200);
    assert.equal(j.body.count, 2);
    assert.deepEqual(j.body.totals, [{ currency: 'USD', total: 35 }]);
    assert.deepEqual(j.body.byMethod.map((m) => [m.method, m.count, m.totals.USD]).sort(), [['BANK', 1, 15], ['CASH', 1, 20]]);
    assert.deepEqual(j.body.byCashier.map((c) => [c.cashier, c.totals.USD]).sort(), [[SEED_USERS.admin.fullName, 15], [SEED_USERS.bursar.fullName, 20]]);
    assert.equal(j.body.payments[0].receiptNumber, `000001/${year()}`);
    const cashOnly = await api('get', '/api/finance/payments?method=CASH');
    assert.equal(cashOnly.body.count, 1);
    const summary = await api('get', '/api/finance/summary');
    assert.equal(summary.body.count, 2);
    assert.deepEqual(summary.body.totals, [{ currency: 'USD', total: 35 }]);
    const dash = await api('get', '/api/dashboard/summary');
    assert.equal(dash.body.cash.count, 2);
    assert.equal((await api('get', '/api/finance/payments?from=2026-09-01&to=2026-10-15')).status, 400, 'période limitée à 31 jours');
    assert.equal((await api('get', '/api/finance/payments?from=2026-10-15&to=2026-10-01')).status, 400);
  });

  test('annulation : comptable ou administrateur, motif obligatoire, frais rétabli, reçu conservé et tuteur prévenu', async () => {
    const fee = await unpaidFee();
    const { body } = await pay(fee, { amount: Number(fee.amountDue), method: 'BANK', bankName: 'Rawbank', externalRef: 'R-9' });
    assert.equal((await prisma.schoolFee.findUniqueOrThrow({ where: { id: fee.id } })).status, 'SOLDE');
    const id = body.receipt.id;

    assert.equal((await api('post', `/api/finance/payments/${id}/cancel`, director).send({ reason: 'Erreur de montant' })).status, 403, 'la direction ne peut pas annuler');
    assert.equal((await api('post', `/api/finance/payments/${id}/cancel`).send({ reason: 'x' })).status, 400);
    const cancelled = await api('post', `/api/finance/payments/${id}/cancel`).send({ reason: 'Erreur de montant' });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.receipt.status, 'CANCELLED');
    assert.equal(cancelled.body.receipt.cancelled.reason, 'Erreur de montant');
    assert.equal(cancelled.body.receipt.cancelled.by, SEED_USERS.bursar.fullName);
    assert.match(cancelled.body.sms.message, /a ete annule/);

    const restored = await prisma.schoolFee.findUniqueOrThrow({ where: { id: fee.id } });
    assert.equal(Number(restored.amountPaid), 0);
    assert.notEqual(restored.status, 'SOLDE');
    assert.equal((await api('post', `/api/finance/payments/${id}/cancel`, admin).send({ reason: 'Encore une fois' })).status, 409);

    const j = await api('get', '/api/finance/payments');
    assert.equal(j.body.count, 0);
    assert.equal(j.body.cancelledCount, 1);
    assert.deepEqual(j.body.totals, []);
    assert.equal(j.body.payments[0].status, 'CANCELLED');

    // Le bordereau d'un reçu annulé peut être ressaisi correctement.
    const redo = await pay(fee, { amount: 10, method: 'BANK', bankName: 'Rawbank', externalRef: 'R-9' });
    assert.equal(redo.status, 201);
    assert.equal(redo.body.receipt.receiptNumber, `000002/${year()}`);
    assert.equal(redo.body.receipt.fee.paidBefore, 0);
  });

  test('Mobile Money en ligne : reçu numéroté à la confirmation ; anciens paiements numérotés à la demande', async () => {
    const fee = await unpaidFee({ student: { guardianPhone: { startsWith: '+24381' } } });
    const init = await api('post', '/api/payments/mobile-money').send({ studentId: fee.studentId, schoolFeeId: fee.id, operator: 'MPESA', phone: fee.student.guardianPhone, amount: 5 });
    assert.equal(init.status, 202, JSON.stringify(init.body));
    const raw = JSON.stringify({ transactionId: init.body.transactionId, reference: init.body.reference, operator: 'MPESA', status: 'SUCCESS', amount: 5, currency: 'USD' });
    const hook = await request(ctx.app).post('/api/payments/mobile-money/webhook').set('Content-Type', 'application/json').set('X-Signature', signWebhook(raw, ctx.config.webhookSecret)).send(raw);
    assert.equal(hook.status, 200);
    assert.equal(hook.body.receiptNumber, `000001/${year()}`);
    const receipt = await api('get', `/api/finance/receipts/${hook.body.receiptId}`);
    assert.equal(receipt.body.receipt.method, 'MOBILE_MONEY');
    assert.equal(receipt.body.receipt.cashier.name, 'Paiement Mobile Money en ligne');
    assert.equal(receipt.body.receipt.fee.balanceAfter, Number(fee.amountDue) - 5);
    assert.ok((await api('get', '/api/finance/payments')).body.payments.some((p) => p.id === hook.body.receiptId));

    const legacy = await prisma.transaction.findFirstOrThrow({ where: { status: 'SUCCESS', receiptNumber: null } });
    const legacyReceipt = await api('get', `/api/finance/receipts/${legacy.id}`);
    assert.equal(legacyReceipt.status, 200);
    assert.equal(legacyReceipt.body.receipt.receiptNumber, `000002/${year()}`);
    const again = await api('get', `/api/finance/receipts/${legacy.id}`);
    assert.equal(again.body.receipt.receiptNumber, `000002/${year()}`, 'numéro attribué une seule fois');
  });
});
