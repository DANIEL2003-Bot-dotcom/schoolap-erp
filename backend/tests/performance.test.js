import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import request from 'supertest';
import { SEED_USERS } from '../prisma/seed.js';
import { averagePct, buildParentSms, detectSignals, studentAverages } from '../src/services/performance.js';
import * as device from '../../dashboard/src/teacher/averages.js';
import { PASSWORDS, buildApp, createPrisma, resetDatabase } from './helpers.js';

const prisma = createPrisma();
let ctx;

async function login(phone, password) {
  const res = await request(ctx.app).post('/api/auth/login').send({ phone, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

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

/* --------------------------- Calculs (sans base) --------------------------- */

let t = 0;
const g = (subjectId, term, score, maxScore = 20) => ({
  subjectId,
  term,
  evaluation: `Éval ${++t}`,
  score,
  maxScore,
  createdAt: new Date(Date.UTC(2026, 9, 1) + t * 60_000),
});
const names = new Map([
  ['math', 'Mathématiques'],
  ['fr', 'Français'],
]);

describe('Moyennes et signaux de baisse (calcul)', () => {
  test('la moyenne est pondérée par les points (un examen pèse plus qu’une interrogation)', () => {
    assert.equal(averagePct([g('math', 'T1', 10, 10), g('math', 'T1', 20, 40)]), 60);
    assert.equal(averagePct([]), null);
    const avg = studentAverages([g('math', 'T1', 15), g('fr', 'T1', 5), g('math', 'T2', 18)]);
    assert.equal(avg.terms.T1.general, 50);
    assert.equal(avg.terms.T1.subjects.math, 75);
    assert.equal(avg.terms.T2.subjects.math, 90);
    assert.equal(avg.year.subjects.math, 82.5);
  });

  test('aucun signal pour un élève régulier', () => {
    assert.deepEqual(detectSignals([g('math', 'T1', 14), g('math', 'T1', 13), g('math', 'T1', 15)], names), []);
  });

  test('chute : dernière cote au moins 10 points sous la moyenne précédente', () => {
    const [s] = detectSignals([g('math', 'T1', 16), g('math', 'T1', 15), g('math', 'T1', 12)], names);
    assert.deepEqual(s.signals, ['CHUTE']);
    assert.equal(s.lastPct, 60);
    assert.equal(s.referencePct, 77.5);
    assert.match(s.summary, /^Mathématiques : baisse de 18 points/);
    // 9,5 points de baisse seulement : pas d'alerte ; une seule cote précédente : pas de comparaison
    assert.deepEqual(detectSignals([g('math', 'T1', 16), g('math', 'T1', 15), g('math', 'T1', 13.6)], names), []);
    assert.deepEqual(detectSignals([g('math', 'T1', 18), g('math', 'T1', 11)], names), []);
  });

  test('deux échecs de suite et moyenne sous 50 %', () => {
    const [s] = detectSignals([g('fr', 'T2', 9), g('fr', 'T2', 8)], names);
    assert.deepEqual(s.signals, ['ECHECS_CONSECUTIFS', 'FAIBLE']);
    assert.equal(s.averagePct, 42.5);
    // Moyenne du trimestre sous 50 % sans deux échecs consécutifs
    const [f] = detectSignals([g('fr', 'T3', 4), g('fr', 'T3', 11)], names);
    assert.deepEqual(f.signals, ['FAIBLE']);
    // Une seule cote faible : pas encore d'alerte
    assert.deepEqual(detectSignals([g('fr', 'T1', 6)], names), []);
  });

  test('moyenne générale en baisse d’un trimestre à l’autre', () => {
    const grades = [g('math', 'T1', 16), g('fr', 'T1', 16), g('math', 'T1', 16), g('math', 'T2', 13), g('fr', 'T2', 13), g('fr', 'T2', 13)];
    const general = detectSignals(grades, names).find((s) => s.subjectId === null);
    assert.equal(general.averagePct, 65);
    assert.equal(general.referencePct, 80);
    assert.match(general.summary, /Moyenne générale en baisse : 65 % au T2 contre 80 % au T1/);
  });

  test('le téléphone de l’enseignant calcule exactement comme le serveur (hors ligne)', () => {
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let k = 0; k < 200; k++) {
      const grades = Array.from({ length: 1 + Math.floor(rand() * 14) }, () =>
        g(rand() < 0.5 ? 'math' : 'fr', ['T1', 'T2', 'T3'][Math.floor(rand() * 3)], Math.round(rand() * 40) / 2, rand() < 0.2 ? 40 : 20),
      );
      const strip = (list) => list.map(({ smsPart, ...rest }) => rest);
      assert.deepEqual(device.detectSignals(grades, names), strip(detectSignals(grades, names)));
      assert.deepEqual(device.studentAverages(grades), studentAverages(grades));
    }
    const cls = { students: [{ id: 'a' }, { id: 'b' }] };
    const report = device.classReport(cls, [{ ...g('math', 'T1', 8), studentId: 'a' }, { ...g('math', 'T1', 7), studentId: 'a' }, { ...g('math', 'T1', 15), studentId: 'b' }], [{ id: 'math', name: 'Mathématiques' }]);
    assert.equal(report.struggling.length, 1);
    assert.equal(report.struggling[0].student.id, 'a');
    assert.deepEqual(report.termsWithGrades, ['T1']);
  });

  test('le SMS au tuteur tient en un message même avec plusieurs matières', () => {
    const student = { firstName: 'Amani', lastName: 'Kasereka' };
    const one = buildParentSms('Institut Mwanga', student, ['Mathématiques 40 %']);
    assert.match(one, /^Institut Mwanga: les résultats de Amani KASEREKA baissent \(Mathématiques 40 %\)/);
    const many = buildParentSms('Institut Mwanga', student, ['Mathématiques 40 %', 'Français 35 %', 'Physique 42 %', 'Chimie 30 %', 'Anglais 45 %']);
    assert.ok(many.length <= 160, many);
    assert.match(many, /\+\d\)/);
  });
});

/* ------------------------------ Parcours API ------------------------------ */

describe('Alertes de baisse des résultats (API)', () => {
  async function setup() {
    const cls = await prisma.class.findFirstOrThrow({ where: { name: '3e Humanités Commerciale' }, include: { students: { orderBy: { matricule: 'asc' } } } });
    const compta = await prisma.subject.findFirstOrThrow({ where: { name: 'Comptabilité' } });
    const token = await login(SEED_USERS.teacher2.phone, PASSWORDS.teacher);
    let n = 0;
    const send = (student, scores, extra = {}) =>
      request(ctx.app)
        .post('/api/grades/sync')
        .set(auth(token))
        .send(
          scores.map((score) => ({
            id: randomUUID(),
            studentId: student.id,
            subjectId: compta.id,
            term: 'T1',
            evaluation: `Interrogation ${++n}`,
            maxScore: 20,
            score,
            clientUpdatedAt: new Date().toISOString(),
            ...extra,
          })),
        );
    return { cls, compta, token, send, student: cls.students[0] };
  }
  const smsCount = (studentId) => prisma.smsLog.count({ where: { studentId, type: 'PERFORMANCE_ALERT' } });

  test('une baisse ouvre UNE alerte et UN SMS au tuteur ; l’alerte suit les cotes puis se ferme', async () => {
    const { send, student, token } = await setup();

    const good = await send(student, [16, 15]);
    assert.equal(good.status, 200, JSON.stringify(good.body));
    assert.equal(good.body.alerts.opened, 0);

    const drop = await send(student, [8]);
    assert.equal(drop.body.alerts.opened, 1);
    assert.equal(drop.body.alerts.smsSent, 1);
    const [alert] = drop.body.alerts.newAlerts;
    assert.equal(alert.subjectName, 'Comptabilité');
    assert.deepEqual(alert.signals, ['CHUTE']);
    assert.equal(alert.smsStatus, 'SENT');
    assert.equal(await smsCount(student.id), 1);
    const log = await prisma.smsLog.findFirstOrThrow({ where: { studentId: student.id, type: 'PERFORMANCE_ALERT' } });
    assert.equal(log.phone, student.guardianPhone);
    assert.match(log.message, /résultats de .* baissent \(Comptabilité : dernière cote 40 %\)/);
    assert.ok(ctx.printed.some((p) => p.includes('ALERTE RÉSULTATS SCOLAIRES')));

    // La baisse continue : même alerte mise à jour, pas de nouveau SMS
    const worse = await send(student, [7]);
    assert.equal(worse.body.alerts.opened, 0);
    assert.equal(worse.body.alerts.updated, 1);
    assert.equal(await smsCount(student.id), 1);
    const open = await prisma.performanceAlert.findMany({ where: { studentId: student.id, status: { not: 'RESOLVED' } } });
    assert.equal(open.length, 1);
    assert.deepEqual(open[0].signals.sort(), ['CHUTE', 'ECHECS_CONSECUTIFS']);

    // L'enseignant voit l'alerte dans son application
    const boot = await request(ctx.app).get('/api/teacher/bootstrap').set(auth(token));
    assert.equal(boot.status, 200);
    assert.equal(boot.body.alerts.length, 1);
    assert.equal(boot.body.alerts[0].studentId, student.id);
    assert.ok(boot.body.grades.every((x) => typeof x.createdAt === 'string'));

    // Les résultats remontent : l'alerte se ferme toute seule
    const better = await send(student, [20]);
    assert.equal(better.body.alerts.resolved, 1);
    assert.equal(await prisma.performanceAlert.count({ where: { studentId: student.id, status: 'RESOLVED' } }), 1);
    const after = await request(ctx.app).get('/api/teacher/alerts').set(auth(token));
    assert.equal(after.body.alerts.length, 0);

    // Nouvelle baisse moins de 24 h après le SMS : nouvelle alerte, mais pas de second SMS
    const again = await send(student, [5]);
    assert.equal(again.body.alerts.opened, 1);
    assert.equal(again.body.alerts.smsSent, 0);
    assert.equal(again.body.alerts.newAlerts[0].smsStatus, 'SKIPPED_RECENT');
    assert.equal(await smsCount(student.id), 1);
  });

  test('plusieurs matières en baisse dans la même saisie : un seul SMS', async () => {
    const { cls, token, student } = await setup();
    const subjects = await prisma.subject.findMany({ where: { name: { in: ['Comptabilité', 'Français'] } } });
    assert.equal(subjects.length, 2);
    const records = subjects.flatMap((s) =>
      [8, 7].map((score, i) => ({
        id: randomUUID(),
        studentId: student.id,
        subjectId: s.id,
        term: 'T2',
        evaluation: `Devoir ${i + 1}`,
        maxScore: 20,
        score,
      })),
    );
    const res = await request(ctx.app).post('/api/grades/sync').set(auth(token)).send(records);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.alerts.opened, 2);
    assert.equal(res.body.alerts.smsSent, 1);
    assert.equal(await smsCount(student.id), 1);
    assert.ok(cls.students.length > 1);
  });

  test('la direction voit les élèves en difficulté, la fiche élève et peut marquer « suivi »', async () => {
    const { send, student } = await setup();
    await send(student, [9, 6]);

    const director = await login(SEED_USERS.director.phone, PASSWORDS.director);
    const summary = await request(ctx.app).get('/api/dashboard/summary').set(auth(director));
    assert.equal(summary.status, 200);
    assert.equal(summary.body.performanceAlerts.openCount, 1);
    assert.equal(summary.body.performanceAlerts.studentsCount, 1);
    assert.equal(summary.body.performanceAlerts.pendingStudents, 1);
    const [alert] = summary.body.performanceAlerts.alerts;
    assert.equal(alert.className, '3e Humanités Commerciale');
    assert.deepEqual(alert.signalLabels, ['Deux échecs de suite', 'Moyenne sous 50 %']);

    const detail = await request(ctx.app).get(`/api/admin/students/${student.id}`).set(auth(director));
    assert.equal(detail.status, 200);
    assert.equal(detail.body.performance.passMark, 50);
    assert.equal(detail.body.performance.averages.terms.T1.general, 37.5);
    assert.equal(detail.body.performance.alerts.length, 1);

    const ack = await request(ctx.app)
      .post(`/api/dashboard/performance-alerts/${alert.id}/acknowledge`)
      .set(auth(director))
      .send({ note: 'Parent convoqué lundi' });
    assert.equal(ack.status, 200, JSON.stringify(ack.body));
    assert.equal(ack.body.alert.status, 'ACKNOWLEDGED');
    assert.equal(ack.body.alert.note, 'Parent convoqué lundi');
    assert.equal(ack.body.alert.acknowledgedBy, SEED_USERS.director.fullName);

    const list = await request(ctx.app).get('/api/dashboard/performance-alerts').set(auth(director));
    assert.equal(list.body.openCount, 1);
    assert.equal(list.body.pendingStudents, 0);

    const teacher = await login(SEED_USERS.teacher2.phone, PASSWORDS.teacher);
    const forbidden = await request(ctx.app).get('/api/dashboard/performance-alerts').set(auth(teacher));
    assert.equal(forbidden.status, 403);
  });

  test('un enseignant ne voit et ne traite que les alertes de ses classes', async () => {
    const { send, student, token } = await setup();
    await send(student, [9, 6]);
    const alert = await prisma.performanceAlert.findFirstOrThrow({ where: { studentId: student.id } });

    const other = await login(SEED_USERS.teacher1.phone, PASSWORDS.teacher);
    const boot = await request(ctx.app).get('/api/teacher/bootstrap').set(auth(other));
    assert.equal(boot.body.alerts.length, 0);
    const denied = await request(ctx.app).post(`/api/teacher/alerts/${alert.id}/acknowledge`).set(auth(other)).send({});
    assert.equal(denied.status, 403);

    const ok = await request(ctx.app).post(`/api/teacher/alerts/${alert.id}/acknowledge`).set(auth(token)).send({ note: 'Remédiation le mercredi' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.alert.status, 'ACKNOWLEDGED');
    const bad = await request(ctx.app).post(`/api/teacher/alerts/${randomUUID()}/acknowledge`).set(auth(token)).send({});
    assert.equal(bad.status, 404);

    // Une alerte prise en charge reste unique : une nouvelle mauvaise cote ne rouvre rien ni ne renvoie de SMS
    const more = await send(student, [5]);
    assert.equal(more.body.alerts.opened, 0);
    assert.equal(await smsCount(student.id), 1);
    assert.equal((await prisma.performanceAlert.findUniqueOrThrow({ where: { id: alert.id } })).status, 'ACKNOWLEDGED');
  });
});
