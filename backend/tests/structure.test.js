import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { SEED_USERS } from '../prisma/seed.js';
import { BCRYPT_COST, OFFICES } from '../src/services/roles.js';
import { PASSWORDS, buildApp, createPrisma, resetDatabase } from './helpers.js';

/* Structure administrative EPST (bureaux + rôles) et verrouillage de l'API. */

const prisma = createPrisma();
let ctx;
let director;

async function login(phone, password) {
  const res = await request(ctx.app).post('/api/auth/login').send({ phone, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const api = (method, path, token = director) => request(ctx.app)[method](path).set(auth(token));

async function createStaff(role, phone, extra = {}) {
  const res = await api('post', '/api/admin/users').send({ fullName: `Agent ${role}`, phone, role, password: 'Ecole2026x', ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return (await login(phone, 'Ecole2026x')).token;
}

before(() => prisma.$connect());
after(() => prisma.$disconnect());
beforeEach(async () => {
  await resetDatabase(prisma);
  ctx = buildApp(prisma);
  director = (await login(SEED_USERS.director.phone, PASSWORDS.director)).token;
});

describe('Bureaux et rôles EPST', () => {
  test('les 5 bureaux officiels existent et le personnel y est rattaché', async () => {
    const res = await api('get', '/api/admin/overview');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.offices.map((o) => o.code).sort(), OFFICES.map((o) => o.code).sort());
    const byCode = Object.fromEntries(res.body.offices.map((o) => [o.code, o]));
    assert.equal(byCode.DIRECTION.members, 1);
    assert.equal(byCode.SALLE_DES_PROFS.members, 2);
    assert.equal(byCode.COMPTABILITE.name, 'Comptabilité / Caisse');
    const directorRow = res.body.staff.find((u) => u.role === 'DIRECTOR');
    assert.equal(directorRow.office, 'DIRECTION');
    assert.ok(res.body.roles.some((r) => r.code === 'PREFET' && r.label === 'Préfet des études'));
    assert.ok(!res.body.assignableRoles.includes('ADMIN'), 'un directeur ne crée pas d’administrateur');
  });

  test('création Préfet, D.E., D.D., Comptable, Enseignant : bureau par défaut et mot de passe haché (bcrypt 12)', async () => {
    const expected = { PREFET: 'ETUDES', DIRECTEUR_ETUDES: 'ETUDES', DIRECTEUR_DISCIPLINE: 'DISCIPLINE', BURSAR: 'COMPTABILITE', TEACHER: 'SALLE_DES_PROFS' };
    let n = 10;
    for (const [role, office] of Object.entries(expected)) {
      n += 1;
      const phone = `09700000${n}`;
      const res = await api('post', '/api/admin/users').send({ fullName: `Agent ${role}`, phone, role, password: 'Ecole2026x' });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.user.office, office);
      assert.equal(res.body.user.passwordHash, undefined, 'le hash ne sort jamais de l’API');
      const row = await prisma.user.findUniqueOrThrow({ where: { phone: `+2439700000${n}` }, include: { office: true } });
      assert.equal(row.office.code, office);
      assert.notEqual(row.passwordHash, 'Ecole2026x');
      assert.match(row.passwordHash, new RegExp(`^\\$2[aby]\\$${BCRYPT_COST}\\$`));
      assert.ok(await bcrypt.compare('Ecole2026x', row.passwordHash));
      const session = await login(phone, 'Ecole2026x');
      assert.equal(session.user.role, role);
      assert.equal(session.user.office.code, office);
    }
  });

  test('bureau choisi explicitement, mots de passe faibles refusés, rôle Admin réservé', async () => {
    const res = await api('post', '/api/admin/users').send({ fullName: 'Enseignant surveillant', phone: '0970000031', role: 'TEACHER', office: 'DISCIPLINE', password: 'Ecole2026x' });
    assert.equal(res.body.user.office, 'DISCIPLINE');
    for (const password of ['court1', 'sanschiffre', '12345678']) {
      const weak = await api('post', '/api/admin/users').send({ fullName: 'X', phone: '0970000032', role: 'TEACHER', password });
      assert.equal(weak.status, 400, password);
    }
    const admin = await api('post', '/api/admin/users').send({ fullName: 'X', phone: '0970000033', role: 'ADMIN', password: 'Ecole2026x' });
    assert.equal(admin.status, 403);
  });

  test('changement de rôle : bureau mis à jour, classes libérées, pas de modification de son propre rôle', async () => {
    const kambale = await prisma.user.findUniqueOrThrow({ where: { phone: SEED_USERS.teacher1.phone } });
    const res = await api('patch', `/api/admin/users/${kambale.id}`).send({ role: 'DIRECTEUR_DISCIPLINE' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.user.office, 'DISCIPLINE');
    assert.equal(await prisma.class.count({ where: { teacherId: kambale.id } }), 0);
    const me = await prisma.user.findUniqueOrThrow({ where: { phone: SEED_USERS.director.phone } });
    assert.equal((await api('patch', `/api/admin/users/${me.id}`).send({ role: 'TEACHER' })).status, 400);
  });

  test('permissions : Préfet gère le personnel, D.E. les classes, D.D. consulte et fait l’appel, Comptable encaisse', async () => {
    const prefet = await createStaff('PREFET', '0970000041');
    const de = await createStaff('DIRECTEUR_ETUDES', '0970000042');
    const dd = await createStaff('DIRECTEUR_DISCIPLINE', '0970000043');
    const comptable = await createStaff('BURSAR', '0970000044');

    assert.equal((await api('post', '/api/admin/users', prefet).send({ fullName: 'Nouvel enseignant', phone: '0970000045', role: 'TEACHER', password: 'Ecole2026x' })).status, 201);
    assert.equal((await api('post', '/api/admin/users', de).send({ fullName: 'X', phone: '0970000046', role: 'TEACHER', password: 'Ecole2026x' })).status, 403);
    assert.equal((await api('post', '/api/admin/classes', de).send({ level: '1re Humanités', option: 'Littéraire' })).status, 201);
    assert.equal((await api('post', '/api/admin/classes', comptable).send({ level: '2e Humanités' })).status, 403);

    assert.equal((await api('get', '/api/dashboard/summary', dd)).status, 200);
    assert.equal((await api('get', '/api/teacher/bootstrap', dd)).status, 200);
    assert.equal((await api('post', '/api/grades/sync', dd).send({ records: [] })).status, 403);
    const cls = await prisma.class.findFirstOrThrow({ where: { name: '5e Primaire A' } });
    assert.equal((await api('post', '/api/admin/students', dd).send({ classId: cls.id, lastName: 'A', middleName: 'B', firstName: 'C', gender: 'F', guardianPhone: '0991112233' })).status, 403);

    const fee = await prisma.schoolFee.findFirstOrThrow({ where: { status: 'INSOLVABLE' } });
    assert.equal((await api('post', `/api/fees/${fee.id}/remind`, dd)).status, 403);
    assert.equal((await api('post', `/api/fees/${fee.id}/remind`, comptable)).status, 200);

    const teacher = (await login(SEED_USERS.teacher1.phone, PASSWORDS.teacher)).token;
    assert.equal((await api('get', '/api/dashboard/summary', teacher)).status, 403);
    assert.equal((await api('get', '/api/admin/overview', teacher)).status, 403);
  });
});

describe('Verrouillage de l’API', () => {
  test('toutes les routes métier exigent un jeton valide', async () => {
    const routes = [
      ['get', '/api/auth/me'],
      ['get', '/api/dashboard/summary'],
      ['get', '/api/admin/overview'],
      ['get', '/api/admin/students'],
      ['get', '/api/teacher/bootstrap'],
      ['post', '/api/attendance/sync'],
      ['post', '/api/payments/mobile-money'],
      ['get', '/api/payments/mobile-money/TX-20261024-AAAAAAAA'],
    ];
    for (const [method, path] of routes) {
      const none = await request(ctx.app)[method](path);
      assert.equal(none.status, 401, `${method} ${path} sans jeton`);
      const forged = await request(ctx.app)[method](path).set(auth('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.faux'));
      assert.equal(forged.status, 401, `${method} ${path} jeton falsifié`);
    }
    assert.equal((await request(ctx.app).get('/api/health')).status, 200, 'la sonde de santé Render reste publique');
  });

  test('un compte désactivé perd immédiatement l’accès, /me renvoie le profil complet', async () => {
    const session = await login(SEED_USERS.teacher2.phone, PASSWORDS.teacher);
    const me = await api('get', '/api/auth/me', session.token);
    assert.equal(me.status, 200);
    assert.equal(me.body.user.roleLabel, 'Enseignant');
    assert.equal(me.body.user.office.code, 'SALLE_DES_PROFS');
    assert.deepEqual(me.body.user.permissions.sort(), ['ENTER_GRADES', 'TAKE_ATTENDANCE']);
    assert.equal(me.body.school.epstCode, 'NK1-GOMA-0427');

    const target = await prisma.user.findUniqueOrThrow({ where: { phone: SEED_USERS.teacher2.phone } });
    await api('patch', `/api/admin/users/${target.id}`).send({ isActive: false }).expect(200);
    assert.equal((await api('get', '/api/auth/me', session.token)).status, 401);
  });
});
