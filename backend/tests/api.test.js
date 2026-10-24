import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import request from 'supertest';
import { SEED_USERS } from '../prisma/seed.js';
import { signWebhook } from '../src/services/mobileMoney.js';
import { addDays, formatDateFr, todayIn, zonedDayRange } from '../src/utils/dates.js';
import { detectOperator } from '../src/utils/phone.js';
import { studentFullName } from '../src/utils/names.js';
import { PASSWORDS, buildApp, createPrisma, resetDatabase, testConfig } from './helpers.js';

const prisma = createPrisma();
let ctx;

async function login(phone, password) {
  const res = await request(ctx.app).post('/api/auth/login').send({ phone, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function classByName(name) {
  return prisma.class.findFirstOrThrow({ where: { name }, include: { students: { orderBy: { matricule: 'asc' } } } });
}

function attendanceRecord(student, date, isPresent, clientUpdatedAt = new Date().toISOString()) {
  return { id: randomUUID(), studentId: student.id, date, isPresent, clientUpdatedAt, studentName: 'ignoré', parentPhone: '+243000' };
}

function operatorFor(phone) {
  return detectOperator(phone);
}

async function unpaidFee() {
  return prisma.schoolFee.findFirstOrThrow({
    where: { status: 'INSOLVABLE' },
    include: { student: true },
    orderBy: { id: 'asc' },
  });
}

before(async () => {
  await prisma.$connect();
});
after(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDatabase(prisma);
  ctx = buildApp(prisma);
});

describe('Authentification', () => {
  test('connexion avec un numéro local, puis /me', async () => {
    const res = await request(ctx.app).post('/api/auth/login').send({ phone: '0970000002', password: PASSWORDS.teacher });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, 'TEACHER');
    assert.equal(res.body.school.epstCode, 'NK1-GOMA-0427');
    const me = await request(ctx.app).get('/api/auth/me').set(auth(res.body.token));
    assert.equal(me.status, 200);
    assert.equal(me.body.user.fullName, SEED_USERS.teacher1.fullName);
  });

  test('mauvais mot de passe → 401, jeton absent → 401, JSON invalide → 400', async () => {
    const bad = await request(ctx.app).post('/api/auth/login').send({ phone: SEED_USERS.teacher1.phone, password: 'faux-mot' });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error.code, 'UNAUTHORIZED');
    const none = await request(ctx.app).get('/api/teacher/bootstrap');
    assert.equal(none.status, 401);
    const json = await request(ctx.app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"phone":');
    assert.equal(json.status, 400);
    assert.equal(json.body.error.code, 'INVALID_JSON');
  });

  test('un compte désactivé perd l’accès immédiatement', async () => {
    const token = await login(SEED_USERS.teacher1.phone, PASSWORDS.teacher);
    await prisma.user.update({ where: { phone: SEED_USERS.teacher1.phone }, data: { isActive: false } });
    const res = await request(ctx.app).get('/api/teacher/bootstrap').set(auth(token));
    assert.equal(res.status, 401);
  });

  test('un enseignant ne peut pas ouvrir le tableau de bord', async () => {
    const token = await login(SEED_USERS.teacher1.phone, PASSWORDS.teacher);
    const res = await request(ctx.app).get('/api/dashboard/summary').set(auth(token));
    assert.equal(res.status, 403);
  });
});

describe('Application mobile — bootstrap et synchronisation', () => {
  test('bootstrap : uniquement les classes de l’enseignant, sans téléphone des tuteurs', async () => {
    const token = await login(SEED_USERS.teacher1.phone, PASSWORDS.teacher);
    const res = await request(ctx.app).get('/api/teacher/bootstrap').set(auth(token));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.classes.map((c) => c.name).sort(), ['4e Humanités Scientifique', '5e Primaire A']);
    assert.equal(res.body.subjects.length, 6);
    assert.equal(res.body.serverDate, todayIn('Africa/Lubumbashi'));
    const student = res.body.classes[0].students[0];
    assert.ok(student.matricule);
    assert.equal(student.guardianPhone, undefined);
    // L'appel du jour de la 4e Humanités est déjà présent dans le seed, pas celui du 5e Primaire A.
    const h4 = res.body.classes.find((c) => c.name.startsWith('4e'));
    assert.equal(res.body.attendance.length, h4.students.length);
  });

  test('sync des présences : SMS exact pour chaque absent, idempotent', async () => {
    const token = await login(SEED_USERS.teacher1.phone, PASSWORDS.teacher);
    const cls = await classByName('5e Primaire A');
    const today = todayIn('Africa/Lubumbashi');
    const records = cls.students.map((s, i) => attendanceRecord(s, today, i >= 2));

    const res = await request(ctx.app).post('/api/attendance/sync').set(auth(token)).send({ records });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.summary.created, cls.students.length);
    assert.equal(res.body.summary.smsSent, 2);

    const expected = `Alerte École : Votre enfant ${studentFullName(cls.students[0])} a été marqué ABSENT ce ${formatDateFr(today)}.`;
    assert.ok(ctx.printed.some((block) => block.includes(expected)), 'Le SMS doit apparaître dans la console');
    const log = await prisma.smsLog.findFirst({ where: { studentId: cls.students[0].id, type: 'ABSENCE_ALERT' } });
    assert.equal(log.message, expected);
    assert.equal(log.phone, cls.students[0].guardianPhone);

    // Renvoi du même lot (réseau coupé avant l'accusé) : aucun doublon, aucun nouveau SMS.
    const again = await request(ctx.app).post('/api/attendance/sync').set(auth(token)).send({ records });
    assert.equal(again.status, 200);
    assert.equal(again.body.summary.unchanged, cls.students.length);
    assert.equal(again.body.summary.smsSent, 0);
    assert.equal(await prisma.smsLog.count({ where: { studentId: cls.students[0].id, type: 'ABSENCE_ALERT', createdAt: { gte: new Date(Date.now() - 60_000) } } }), 1);
    assert.equal(await prisma.attendance.count({ where: { classId: cls.id } }), cls.students.length * 6);
  });

  test('dernière écriture gagnante et données périmées ignorées', async () => {
    const token = await login(SEED_USERS.teacher1.phone, PASSWORDS.teacher);
    const cls = await classByName('5e Primaire A');
    const today = todayIn('Africa/Lubumbashi');
    const s = cls.students[3];
    const t0 = new Date(Date.now() - 60_000).toISOString();
    const t1 = new Date().toISOString();
    await request(ctx.app).post('/api/attendance/sync').set(auth(token)).send([attendanceRecord(s, today, true, t0)]).expect(200);
    const upd = await request(ctx.app).post('/api/attendance/sync').set(auth(token)).send([attendanceRecord(s, today, false, t1)]);
    assert.equal(upd.body.results[0].result, 'updated');
    const stale = await request(ctx.app).post('/api/attendance/sync').set(auth(token)).send([attendanceRecord(s, today, true, t0)]);
    assert.equal(stale.body.results[0].result, 'stale');
    const row = await prisma.attendance.findFirst({ where: { studentId: s.id, date: new Date(`${today}T00:00:00Z`) } });
    assert.equal(row.status, 'ABSENT');
    // L'id renvoyé est celui du serveur (premier enregistrement), pour que le mobile remappe.
    assert.equal(stale.body.results[0].id, row.id);
  });

  test('élève d’une autre classe, date future ou lot vide → rejet', async () => {
    const token = await login(SEED_USERS.teacher1.phone, PASSWORDS.teacher);
    const other = await classByName('3e Humanités Commerciale');
    const today = todayIn('Africa/Lubumbashi');
    const res = await request(ctx.app).post('/api/attendance/sync').set(auth(token)).send([attendanceRecord(other.students[0], today, false)]);
    assert.equal(res.status, 400);
    assert.match(res.body.error.details[0].errors[0].message, /n’appartient pas/);

    const mine = await classByName('5e Primaire A');
    const future = await request(ctx.app)
      .post('/api/attendance/sync')
      .set(auth(token))
      .send([attendanceRecord(mine.students[0], addDays(today, 2), true), attendanceRecord(mine.students[1], today, true)]);
    assert.equal(future.status, 200);
    assert.equal(future.body.summary.rejected, 1);
    assert.equal(future.body.summary.saved, 1);

    const empty = await request(ctx.app).post('/api/attendance/sync').set(auth(token)).send([]);
    assert.equal(empty.status, 400);
  });

  test('sync des cotes : validation et enregistrement', async () => {
    const token = await login(SEED_USERS.teacher2.phone, PASSWORDS.teacher);
    const cls = await classByName('3e Humanités Commerciale');
    const compta = await prisma.subject.findFirstOrThrow({ where: { name: 'Comptabilité' } });
    const now = new Date().toISOString();
    const base = { subjectId: compta.id, term: 'T1', evaluation: 'Interrogation 1', maxScore: 20, clientUpdatedAt: now };
    const res = await request(ctx.app)
      .post('/api/grades/sync')
      .set(auth(token))
      .send({
        records: [
          { ...base, id: randomUUID(), studentId: cls.students[0].id, score: 14.5 },
          { ...base, id: randomUUID(), studentId: cls.students[1].id, score: 25 },
          { ...base, id: randomUUID(), studentId: cls.students[2].id, score: 9, term: 'T4' },
        ],
      });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.summary.saved, 1);
    assert.equal(res.body.summary.rejected, 2);
    const grade = await prisma.grade.findFirstOrThrow({ where: { studentId: cls.students[0].id } });
    assert.equal(Number(grade.score), 14.5);

    const allBad = await request(ctx.app)
      .post('/api/grades/sync')
      .set(auth(token))
      .send([{ ...base, id: randomUUID(), studentId: cls.students[1].id, score: -1 }]);
    assert.equal(allBad.status, 400);
  });
});

describe('Paiements Mobile Money', () => {
  async function initiate(fee, overrides = {}) {
    const remaining = Number(fee.amountDue) - Number(fee.amountPaid);
    return request(ctx.app)
      .post('/api/payments/mobile-money')
      .send({
        studentId: fee.studentId,
        schoolFeeId: fee.id,
        operator: operatorFor(fee.student.guardianPhone),
        phone: fee.student.guardianPhone,
        amount: remaining,
        ...overrides,
      });
  }

  async function postWebhook(payload, secret = ctx.config.webhookSecret) {
    const raw = JSON.stringify(payload);
    return request(ctx.app)
      .post('/api/payments/mobile-money/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signWebhook(raw, secret))
      .send(raw);
  }

  test('initiation → webhook signé → frais SOLDÉ + reçu SMS, webhook rejoué ignoré', async () => {
    const fee = await unpaidFee();
    const init = await initiate(fee);
    assert.equal(init.status, 202, JSON.stringify(init.body));
    assert.equal(init.body.status, 'PENDING');
    assert.match(init.body.transactionId, /^TX-\d{8}-[0-9A-F]{8}$/);

    const payload = {
      transactionId: init.body.transactionId,
      reference: init.body.reference,
      operator: init.body.operator,
      status: 'SUCCESS',
      amount: init.body.amount,
      currency: 'USD',
    };
    const hook = await postWebhook(payload);
    assert.equal(hook.status, 200, JSON.stringify(hook.body));
    assert.equal(hook.body.fee.status, 'SOLDE');
    assert.equal(hook.body.fee.remaining, 0);

    const updated = await prisma.schoolFee.findUniqueOrThrow({ where: { id: fee.id } });
    assert.equal(updated.status, 'SOLDE');
    assert.equal(Number(updated.amountPaid), Number(updated.amountDue));
    assert.ok(ctx.printed.some((b) => b.includes('REÇU DE PAIEMENT')));

    const replay = await postWebhook(payload);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.alreadyProcessed, true);
    const again = await prisma.schoolFee.findUniqueOrThrow({ where: { id: fee.id } });
    assert.equal(Number(again.amountPaid), Number(updated.amountPaid));

    const status = await request(ctx.app).get(`/api/payments/mobile-money/${init.body.transactionId}`);
    assert.equal(status.body.status, 'SUCCESS');
  });

  test('paiement partiel : statut conservé, reste à payer annoncé', async () => {
    const fee = await unpaidFee();
    const init = await initiate(fee, { amount: 5 });
    assert.equal(init.status, 202);
    const hook = await postWebhook({
      transactionId: init.body.transactionId,
      reference: init.body.reference,
      operator: init.body.operator,
      status: 'SUCCESS',
      amount: 5,
      currency: 'USD',
    });
    assert.equal(hook.body.fee.status, 'INSOLVABLE');
    assert.ok(ctx.printed.some((b) => b.includes('Reste à payer')));
  });

  test('échec opérateur : transaction FAILED, solde inchangé', async () => {
    const fee = await unpaidFee();
    const init = await initiate(fee);
    const hook = await postWebhook({
      transactionId: init.body.transactionId,
      reference: init.body.reference,
      operator: init.body.operator,
      status: 'FAILED',
      amount: init.body.amount,
      currency: 'USD',
      reason: 'Solde insuffisant',
    });
    assert.equal(hook.body.status, 'FAILED');
    const same = await prisma.schoolFee.findUniqueOrThrow({ where: { id: fee.id } });
    assert.equal(Number(same.amountPaid), Number(fee.amountPaid));
  });

  test('un seul paiement en attente par frais, même depuis un autre numéro', async () => {
    const fee = await unpaidFee();
    const first = await initiate(fee, { amount: 1 });
    assert.equal(first.status, 202);
    const other = fee.student.guardianPhone.startsWith('+24397') ? '+243810000999' : '+243970000999';
    const second = await initiate(fee, { amount: 1, phone: other, operator: operatorFor(other) });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.details.transactionId, first.body.transactionId);
  });

  test('webhooks concurrents : jamais de trop-perçu', async () => {
    const fee = await unpaidFee();
    const remaining = Number(fee.amountDue) - Number(fee.amountPaid);
    const a = await initiate(fee);
    // Une 2e transaction pour le même solde, créée directement (ex. guichet + Mobile Money simultanés).
    const b = await prisma.transaction.create({
      data: {
        transactionId: 'TX-20261024-CONCUR01',
        operator: a.body.operator,
        reference: 'REF-CONCURRENT-01',
        payerPhone: fee.student.guardianPhone,
        amount: remaining,
        studentId: fee.studentId,
        schoolFeeId: fee.id,
      },
    });
    const payloads = [
      { transactionId: a.body.transactionId, reference: a.body.reference },
      { transactionId: b.transactionId, reference: b.reference },
    ].map((t) => ({ ...t, operator: a.body.operator, status: 'SUCCESS', amount: remaining, currency: 'USD' }));
    const results = await Promise.all(payloads.map((p) => postWebhook(p)));
    assert.deepEqual(results.map((r) => r.status), [200, 200]);
    assert.deepEqual(results.map((r) => r.body.status).sort(), ['FAILED', 'SUCCESS']);
    const updated = await prisma.schoolFee.findUniqueOrThrow({ where: { id: fee.id } });
    assert.equal(Number(updated.amountPaid), Number(updated.amountDue));
    const failed = await prisma.transaction.findFirst({ where: { schoolFeeId: fee.id, status: 'FAILED' } });
    assert.match(failed.failureReason, /remboursement/);
  });

  test('signature invalide → 401', async () => {
    const fee = await unpaidFee();
    const init = await initiate(fee);
    const res = await postWebhook(
      { transactionId: init.body.transactionId, reference: init.body.reference, operator: init.body.operator, status: 'SUCCESS', amount: init.body.amount, currency: 'USD' },
      'mauvais-secret-de-webhook-xx',
    );
    assert.equal(res.status, 401);
  });

  test('numéro incompatible avec l’opérateur, montant excessif, frais soldé', async () => {
    const fee = await unpaidFee();
    const wrongOp = operatorFor(fee.student.guardianPhone) === 'MPESA' ? 'AIRTEL_MONEY' : 'MPESA';
    const mismatch = await initiate(fee, { operator: wrongOp });
    assert.equal(mismatch.status, 400);

    const tooMuch = await initiate(fee, { amount: 999 });
    assert.equal(tooMuch.status, 400);
    assert.match(tooMuch.body.error.message, /dépasse le reste à payer/);

    const solde = await prisma.schoolFee.findFirstOrThrow({ where: { status: 'SOLDE' }, include: { student: true } });
    const paid = await initiate(solde, { amount: 1 });
    assert.equal(paid.status, 409);
  });

  test('bout en bout : rappel opérateur simulé via HTTP réel', async () => {
    let server;
    const port = await new Promise((resolve) => {
      const config = testConfig({ SIMULATE_OPERATOR_CALLBACK: 'true', OPERATOR_CALLBACK_DELAY_MS: '50' });
      const dispatchWebhook = async (rawBody, signature) => {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/payments/mobile-money/webhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Signature': signature },
          body: rawBody,
        });
        return res.status;
      };
      ctx = buildApp(prisma, { config, dispatchWebhook });
      server = ctx.app.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
    try {
      const fee = await unpaidFee();
      const init = await initiate(fee);
      assert.equal(init.status, 202);
      let status = 'PENDING';
      for (let i = 0; i < 40 && status === 'PENDING'; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
        const res = await fetch(`http://127.0.0.1:${port}/api/payments/mobile-money/${init.body.transactionId}`);
        status = (await res.json()).status;
      }
      assert.equal(status, 'SUCCESS');
      const updated = await prisma.schoolFee.findUniqueOrThrow({ where: { id: fee.id } });
      assert.equal(updated.status, 'SOLDE');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe('Tableau de bord du directeur', () => {
  test('KPI cohérents avec la base', async () => {
    const token = await login(SEED_USERS.director.phone, PASSWORDS.director);
    const res = await request(ctx.app).get('/api/dashboard/summary').set(auth(token));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const today = todayIn('Africa/Lubumbashi');
    const absentToday = await prisma.attendance.count({ where: { date: new Date(`${today}T00:00:00Z`), status: 'ABSENT' } });
    assert.equal(res.body.attendance.absent, absentToday);
    assert.equal(res.body.absents.length, absentToday);
    assert.ok(res.body.absents.every((a) => a.smsSent === true));
    assert.deepEqual(res.body.attendance.classesPending, ['5e Primaire A']);
    const insolvent = await prisma.schoolFee.count({ where: { status: 'INSOLVABLE' } });
    assert.equal(res.body.insolvents.length, insolvent);
    const usd = res.body.finance.find((f) => f.currency === 'USD');
    assert.ok(usd.recoveryRate > 0 && usd.recoveryRate < 1);
    assert.equal(usd.outstanding, Number((usd.due - usd.paid).toFixed(2)));

    const bad = await request(ctx.app).get('/api/dashboard/summary?date=2026-02-30').set(auth(token));
    assert.equal(bad.status, 400);
  });

  test('relance SMS d’un insolvable puis délai de 24 h → 429', async () => {
    const token = await login(SEED_USERS.director.phone, PASSWORDS.director);
    const fee = await unpaidFee();
    const res = await request(ctx.app).post(`/api/fees/${fee.id}/remind`).set(auth(token));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.sms.status, 'sent');
    assert.match(res.body.sms.message, /^Rappel École : solde impayé de/);
    const again = await request(ctx.app).post(`/api/fees/${fee.id}/remind`).set(auth(token));
    assert.equal(again.status, 429);
    assert.ok(again.body.error.details.nextAllowedAt);

    const solde = await prisma.schoolFee.findFirstOrThrow({ where: { status: 'SOLDE' } });
    const paid = await request(ctx.app).post(`/api/fees/${solde.id}/remind`).set(auth(token));
    assert.equal(paid.status, 409);
  });

  test('SMS du jour comptés selon le fuseau de l’école (UTC+2), pas en UTC', async () => {
    const token = await login(SEED_USERS.director.phone, PASSWORDS.director);
    const today = todayIn('Africa/Lubumbashi');
    const { start } = zonedDayRange(today, 'Africa/Lubumbashi');
    const student = await prisma.student.findFirstOrThrow();
    await prisma.smsLog.deleteMany({});
    await prisma.smsLog.createMany({
      data: [
        // 23h30 la veille à Goma (21h30 UTC) : ne compte pas
        { studentId: student.id, phone: student.guardianPhone, message: 'veille', type: 'FEE_REMINDER', status: 'SENT', createdAt: new Date(start.getTime() - 30 * 60_000) },
        // 00h30 à Goma (22h30 UTC la veille) : compte pour aujourd'hui
        { studentId: student.id, phone: student.guardianPhone, message: 'jour', type: 'FEE_REMINDER', status: 'SENT', createdAt: new Date(start.getTime() + 30 * 60_000) },
      ],
    });
    const res = await request(ctx.app).get(`/api/dashboard/summary?date=${today}`).set(auth(token));
    assert.equal(res.body.smsSentToday, 1);
  });

  test('CORS : origine autorisée acceptée, origine inconnue refusée', async () => {
    const ok = await request(ctx.app).get('/api/health').set('Origin', 'https://ecole.github.io');
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['access-control-allow-origin'], 'https://ecole.github.io');
    const ko = await request(ctx.app).get('/api/health').set('Origin', 'https://pirate.example');
    assert.equal(ko.status, 403);
  });
});
