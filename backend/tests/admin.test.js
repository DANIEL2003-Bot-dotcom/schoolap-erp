import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import request from 'supertest';
import { SEED_USERS } from '../prisma/seed.js';
import { parseStudentsCsv } from '../src/services/admin.js';
import { PASSWORDS, buildApp, createPrisma, resetDatabase } from './helpers.js';

const prisma = createPrisma();
let ctx;
let director;

async function login(phone, password) {
  const res = await request(ctx.app).post('/api/auth/login').send({ phone, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const api = (method, path, token = director) => request(ctx.app)[method](path).set(auth(token));
const classByName = (name) => prisma.class.findFirstOrThrow({ where: { name } });

before(() => prisma.$connect());
after(() => prisma.$disconnect());
beforeEach(async () => {
  await resetDatabase(prisma);
  ctx = buildApp(prisma);
  director = await login(SEED_USERS.director.phone, PASSWORDS.director);
});

describe('Référentiel', () => {
  test('vue d’ensemble pour la direction, refusée aux enseignants', async () => {
    const res = await api('get', '/api/admin/overview');
    assert.equal(res.status, 200);
    assert.equal(res.body.classes.length, 3);
    assert.equal(res.body.staff.length, 3);
    assert.equal(res.body.subjects.length, 6);
    const h3c = res.body.classes.find((c) => c.name === '3e Humanités Commerciale');
    assert.equal(h3c.teacherName, SEED_USERS.teacher2.fullName);
    assert.equal(h3c.studentCount, 15);

    const teacher = await login(SEED_USERS.teacher1.phone, PASSWORDS.teacher);
    assert.equal((await api('get', '/api/admin/overview', teacher)).status, 403);
  });

  test('classes : création avec nom automatique, doublon, titulaire invalide, suppression', async () => {
    const teacherId = (await prisma.user.findUniqueOrThrow({ where: { phone: SEED_USERS.teacher2.phone } })).id;
    const created = await api('post', '/api/admin/classes').send({ level: '6e Humanités', option: 'Pédagogie générale', teacherId });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.class.name, '6e Humanités Pédagogie générale');

    const dup = await api('post', '/api/admin/classes').send({ level: '6e Humanités', option: 'Pédagogie générale' });
    assert.equal(dup.status, 409);

    const directorId = (await prisma.user.findUniqueOrThrow({ where: { phone: SEED_USERS.director.phone } })).id;
    const bad = await api('post', '/api/admin/classes').send({ level: '1re Primaire', teacherId: directorId });
    assert.equal(bad.status, 400);

    const renamed = await api('patch', `/api/admin/classes/${created.body.class.id}`).send({ section: 'B' });
    assert.equal(renamed.body.class.name, '6e Humanités Pédagogie générale B');

    const full = await classByName('5e Primaire A');
    assert.equal((await api('delete', `/api/admin/classes/${full.id}`)).status, 409);
    assert.equal((await api('delete', `/api/admin/classes/${created.body.class.id}`)).status, 200);
  });

  test('personnel : création d’un enseignant, connexion, désactivation', async () => {
    const res = await api('post', '/api/admin/users').send({ fullName: 'Masika Furaha', phone: '0820000099', role: 'TEACHER', password: 'MotDePasse2026' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.user.phone, '+243820000099');
    assert.equal(res.body.user.passwordHash, undefined);
    const token = await login('0820000099', 'MotDePasse2026');
    assert.ok(token);

    const dup = await api('post', '/api/admin/users').send({ fullName: 'Autre', phone: '+243820000099', role: 'TEACHER', password: 'MotDePasse2026' });
    assert.equal(dup.status, 409);

    // Désactiver Kambale Jean libère ses deux classes et bloque sa connexion
    const kambale = await prisma.user.findUniqueOrThrow({ where: { phone: SEED_USERS.teacher1.phone } });
    const off = await api('patch', `/api/admin/users/${kambale.id}`).send({ isActive: false });
    assert.equal(off.status, 200);
    assert.equal(await prisma.class.count({ where: { teacherId: kambale.id } }), 0);
    const denied = await request(ctx.app).post('/api/auth/login').send({ phone: SEED_USERS.teacher1.phone, password: PASSWORDS.teacher });
    assert.equal(denied.status, 401);

    const me = await prisma.user.findUniqueOrThrow({ where: { phone: SEED_USERS.director.phone } });
    assert.equal((await api('patch', `/api/admin/users/${me.id}`).send({ isActive: false })).status, 400);
  });

  test('matières : création et doublon', async () => {
    const res = await api('post', '/api/admin/subjects').send({ name: 'Géographie', defaultMaxScore: 10 });
    assert.equal(res.status, 201);
    assert.equal(res.body.subject.defaultMaxScore, 10);
    assert.equal((await api('post', '/api/admin/subjects').send({ name: 'Géographie' })).status, 409);
  });
});

describe('Élèves', () => {
  test('inscription : matricule automatique, frais de la classe hérités, visible sur le mobile', async () => {
    const cls = await classByName('5e Primaire A');
    const res = await api('post', '/api/admin/students').send({
      classId: cls.id,
      lastName: 'Kavira',
      middleName: 'Mbambu',
      firstName: 'Espérance',
      gender: 'F',
      guardianName: 'Maman Kavira',
      guardianPhone: '0991234567',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.student.matricule, /^\d{4}-0427-\d{5}$/);
    assert.equal(res.body.student.guardianPhone, '+243991234567');
    assert.equal(res.body.student.fullName, 'KAVIRA MBAMBU Espérance');
    assert.equal(res.body.feesCreated, 3);

    const fees = await prisma.schoolFee.findMany({ where: { studentId: res.body.student.id } });
    assert.deepEqual(fees.map((f) => f.label).sort(), ['Frais scolaires T1', 'Frais scolaires T2', `Inscription ${fees[0].schoolYear}`].sort());
    assert.ok(fees.every((f) => Number(f.amountPaid) === 0));
    assert.equal(fees.find((f) => f.label === 'Frais scolaires T1').status, 'INSOLVABLE'); // échéance passée

    const second = await api('post', '/api/admin/students').send({ classId: cls.id, lastName: 'Paluku', middleName: 'Kasereka', firstName: 'Élie', gender: 'M', guardianPhone: '0811234567', applyClassFees: false });
    assert.equal(second.body.feesCreated, 0);
    assert.equal(Number(second.body.student.matricule.slice(-5)), Number(res.body.student.matricule.slice(-5)) + 1);

    const dup = await api('post', '/api/admin/students').send({ classId: cls.id, lastName: 'X', middleName: 'Y', firstName: 'Z', gender: 'M', guardianPhone: '0811234567', matricule: res.body.student.matricule });
    assert.equal(dup.status, 409);

    const teacher = await login(SEED_USERS.teacher1.phone, PASSWORDS.teacher);
    const boot = await api('get', '/api/teacher/bootstrap', teacher);
    const p5 = boot.body.classes.find((c) => c.id === cls.id);
    assert.ok(p5.students.some((s) => s.id === res.body.student.id));
  });

  test('validation : téléphone et sexe invalides', async () => {
    const cls = await classByName('5e Primaire A');
    const res = await api('post', '/api/admin/students').send({ classId: cls.id, lastName: 'A', middleName: 'B', firstName: 'C', gender: 'X', guardianPhone: '12345' });
    assert.equal(res.status, 400);
    const fields = res.body.error.details.map((d) => d.field);
    assert.ok(fields.includes('gender') && fields.includes('guardianPhone'));
  });

  test('liste : recherche, filtre de classe, pagination, transfert et désinscription', async () => {
    const all = await api('get', '/api/admin/students?pageSize=10');
    assert.equal(all.body.total, 42);
    assert.equal(all.body.students.length, 10);
    assert.ok(all.body.students.every((s) => typeof s.outstanding === 'number'));

    const h3c = await classByName('3e Humanités Commerciale');
    const inClass = await api('get', `/api/admin/students?classId=${h3c.id}`);
    assert.equal(inClass.body.total, 15);

    const target = inClass.body.students[0];
    const search = await api('get', `/api/admin/students?q=${encodeURIComponent(target.matricule)}`);
    assert.equal(search.body.total, 1);

    const p5 = await classByName('5e Primaire A');
    const moved = await api('patch', `/api/admin/students/${target.id}`).send({ classId: p5.id });
    assert.equal(moved.body.student.className, '5e Primaire A');

    await api('patch', `/api/admin/students/${target.id}`).send({ isActive: false }).expect(200);
    assert.equal((await api('get', '/api/admin/students')).body.total, 41);
    assert.equal((await api('get', '/api/admin/students?status=inactive')).body.total, 1);
    const unchanged = await prisma.student.findUniqueOrThrow({ where: { id: target.id } });
    assert.equal(unchanged.guardianName, target.guardianName, 'un PATCH partiel ne doit pas effacer les autres champs');
  });

  test('fiche élève : frais, transactions, assiduité', async () => {
    const s = await prisma.student.findFirstOrThrow({ where: { transactions: { some: {} } } });
    const res = await api('get', `/api/admin/students/${s.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.fees.length, 3);
    assert.ok(res.body.transactions.length >= 1);
    assert.ok(res.body.attendance.present + res.body.attendance.absent >= 5);
  });

  test('import CSV : simulation, erreurs par ligne (rien importé), import réel avec frais', async () => {
    const cls = await classByName('4e Humanités Scientifique');
    const csv = [
      'Nom;Postnom;Prénom;Sexe;Téléphone tuteur;Nom tuteur;Matricule',
      'Mumbere;Kakule;Fiston;M;0971112233;Papa Mumbere;',
      '"Kahambu";"Vagheni";"Aline";F;+243 84 111 2233;;',
      'Katsuva;Muhesi;Joël;Masculin;0821112233;;IMP-001',
    ].join('\n');

    const dry = await api('post', '/api/admin/students/import').send({ classId: cls.id, csv, dryRun: true });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.equal(dry.body.valid, 3);
    assert.equal(dry.body.preview[1].fullName, 'KAHAMBU VAGHENI Aline');
    assert.equal(await prisma.student.count({ where: { classId: cls.id } }), 13);

    const bad = await api('post', '/api/admin/students/import').send({ classId: cls.id, csv: `${csv}\nSans;Telephone;Ici;F;12;;` });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.details.errors[0].line, 5);
    assert.equal(await prisma.student.count({ where: { classId: cls.id } }), 13);

    const ok = await api('post', '/api/admin/students/import').send({ classId: cls.id, csv });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.imported, 3);
    assert.equal(ok.body.feesCreated, 9);
    assert.equal(await prisma.student.count({ where: { classId: cls.id } }), 16);
    assert.ok(await prisma.student.findUnique({ where: { matricule: 'IMP-001' } }));

    const again = await api('post', '/api/admin/students/import').send({ classId: cls.id, csv });
    assert.equal(again.status, 400, 'matricule déjà attribué');
  });

  test('analyse CSV : séparateur virgule et colonnes manquantes', () => {
    const ok = parseStudentsCsv('nom,postnom,prenom,sexe,telephone\nA,B,C,F,0970000123');
    assert.equal(ok.rows.length, 1);
    assert.equal(ok.rows[0].guardianPhone, '+243970000123');
    const ko = parseStudentsCsv('nom;prenom\nA;B');
    assert.match(ko.errors[0].message, /Colonnes manquantes/);
  });
});

describe('Frais', () => {
  test('création groupée idempotente et synthèse par frais', async () => {
    const classes = await prisma.class.findMany({ where: { name: { contains: 'Humanités' } } });
    const body = { classIds: classes.map((c) => c.id), feeType: 'FRAIS_EXAMEN', label: 'Frais d’examen d’État (TENASOSP)', amountDue: 15, dueDate: '2027-03-31' };
    const first = await api('post', '/api/admin/fees/bulk').send(body);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.created, 28);
    const second = await api('post', '/api/admin/fees/bulk').send(body);
    assert.equal(second.body.created, 0);
    assert.equal(second.body.skipped, 28);

    const summary = await api('get', '/api/admin/fees/summary');
    const plan = summary.body.plans.find((p) => p.label === body.label);
    assert.equal(plan.students, 28);
    assert.equal(plan.due, 420);
    assert.equal(plan.enCours, 28);
    const t1 = summary.body.plans.find((p) => p.label === 'Frais scolaires T1');
    assert.equal(t1.solde + t1.enCours + t1.insolvable, t1.students);
  });

  test('remise : montant dû ramené au payé → SOLDÉ ; jamais sous le payé', async () => {
    const fee = await prisma.schoolFee.findFirstOrThrow({ where: { status: 'INSOLVABLE', amountPaid: { gt: 0 } } });
    const tooLow = await api('patch', `/api/admin/fees/${fee.id}`).send({ amountDue: Number(fee.amountPaid) - 1 });
    assert.equal(tooLow.status, 400);
    const ok = await api('patch', `/api/admin/fees/${fee.id}`).send({ amountDue: Number(fee.amountPaid) });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.fee.status, 'SOLDE');

    const other = await prisma.schoolFee.findFirstOrThrow({ where: { status: 'INSOLVABLE', id: { not: fee.id } } });
    const postponed = await api('patch', `/api/admin/fees/${other.id}`).send({ dueDate: '2027-06-30' });
    assert.equal(postponed.body.fee.status, 'EN_COURS');
  });

  test('économat : inscrit des élèves et gère les frais, mais pas les classes', async () => {
    await api('post', '/api/admin/users').send({ fullName: 'Kasoki Neema', phone: '0850000077', role: 'BURSAR', password: 'Economat2026' }).expect(201);
    const bursar = await login('0850000077', 'Economat2026');
    const cls = await classByName('5e Primaire A');
    const created = await api('post', '/api/admin/students', bursar).send({ classId: cls.id, lastName: 'Sikuli', middleName: 'Kambere', firstName: 'Ruth', gender: 'F', guardianPhone: '0891112233' });
    assert.equal(created.status, 201);
    assert.equal((await api('post', '/api/admin/classes', bursar).send({ level: '1re Primaire' })).status, 403);
    assert.equal((await api('post', '/api/admin/users', bursar).send({ fullName: 'X', phone: '0850000078', role: 'TEACHER', password: 'Economat2026' })).status, 403);
    assert.equal((await api('get', '/api/admin/fees/summary', bursar)).status, 200);
  });
});
