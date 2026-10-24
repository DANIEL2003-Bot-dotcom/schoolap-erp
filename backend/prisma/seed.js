/**
 * Données de démonstration — « Institut Mwanga » (Goma, Nord-Kivu).
 * Idempotent : si l'école (code EPST) existe déjà, rien n'est modifié.
 *   node prisma/seed.js
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { absenceMessage } from '../src/services/attendance.js';
import { computeFeeStatus } from '../src/services/fees.js';
import { addDays, toDbDate, todayIn, schoolYearOf } from '../src/utils/dates.js';
import { detectOperator } from '../src/utils/phone.js';

export const SEED_EPST_CODE = 'NK1-GOMA-0427';
export const SEED_USERS = Object.freeze({
  director: { phone: '+243990000001', fullName: 'Mumbere Paluku Didier' },
  teacher1: { phone: '+243970000002', fullName: 'Kambale Jean' },
  teacher2: { phone: '+243810000003', fullName: 'Kavira Esther' },
});

/** Générateur pseudo-aléatoire déterministe (mulberry32) : données identiques à chaque seed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LAST_NAMES = ['Kambale', 'Kahindo', 'Paluku', 'Masika', 'Mumbere', 'Kavugho', 'Muhindo', 'Kasereka', 'Mbusa', 'Vahwere', 'Sikuli', 'Kakule', 'Bahati', 'Ndungo', 'Katembo', 'Mapendo', 'Kyakimwa', 'Musavuli'];
const MIDDLE_NAMES = ['Siwako', 'Mutsunga', 'Vyakuno', 'Kasongo', 'Lukando', 'Nzanzu', 'Kitsa', 'Malyabo', 'Mwenge', 'Kasika', 'Vulere', 'Matumo', 'Kombi', 'Syaghuswa'];
const FIRST_M = ['Jonathan', 'Daniel', 'Patient', 'Josué', 'Emmanuel', 'Christian', 'Moïse', 'Héritier', 'Dieumerci', 'Samuel', 'Prince', 'Exaucé'];
const FIRST_F = ['Grâce', 'Esther', 'Sarah', 'Divine', 'Merveille', 'Ruth', 'Gloire', 'Joëlle', 'Rachel', 'Bénédicte', 'Naomie', 'Élodie'];
const GUARDIAN_PREFIXES = ['81', '82', '83', '84', '85', '89', '97', '98', '99'];

const CLASSES = [
  { key: 'p5a', level: '5e Primaire', option: null, section: 'A', name: '5e Primaire A', teacher: 'teacher1', size: 14, matPrefix: 'P5' },
  { key: 'h4s', level: '4e Humanités', option: 'Scientifique', section: null, name: '4e Humanités Scientifique', teacher: 'teacher1', size: 13, matPrefix: 'H4S' },
  { key: 'h3c', level: '3e Humanités', option: 'Commerciale', section: null, name: '3e Humanités Commerciale', teacher: 'teacher2', size: 15, matPrefix: 'H3C' },
];

const SUBJECTS = [
  { name: 'Mathématiques', defaultMaxScore: 20 },
  { name: 'Français', defaultMaxScore: 20 },
  { name: 'Comptabilité', defaultMaxScore: 20 },
  { name: 'Physique', defaultMaxScore: 20 },
  { name: 'Éducation civique', defaultMaxScore: 10 },
  { name: 'Anglais', defaultMaxScore: 10 },
];

/** Les N derniers jours de classe (dimanches exclus), du plus ancien au plus récent, aujourd'hui exclu. */
function previousSchoolDays(today, count) {
  const days = [];
  let cursor = addDays(today, -1);
  while (days.length < count) {
    if (toDbDate(cursor).getUTCDay() !== 0) days.unshift(cursor);
    cursor = addDays(cursor, -1);
  }
  return days;
}

function atTime(iso, hour, minute) {
  // 08h30 heure de Goma (UTC+2) = 06h30 UTC
  return new Date(`${iso}T${String(hour - 2).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`);
}

export async function runSeed(prisma, opts = {}) {
  const log = opts.log ?? console.log;
  const timezone = opts.timezone ?? process.env.SCHOOL_TIMEZONE ?? 'Africa/Lubumbashi';
  const today = opts.today ?? todayIn(timezone);
  const directorPassword = opts.directorPassword ?? process.env.SEED_DIRECTOR_PASSWORD ?? 'Directeur@2026';
  const teacherPassword = opts.teacherPassword ?? process.env.SEED_TEACHER_PASSWORD ?? 'Enseignant@2026';
  const rand = rng(opts.randomSeed ?? 427);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  const existing = await prisma.school.findUnique({ where: { epstCode: SEED_EPST_CODE } });
  if (existing) {
    log(`[seed] École ${SEED_EPST_CODE} déjà présente : aucune donnée ajoutée.`);
    return { skipped: true, schoolId: existing.id };
  }

  const [directorHash, teacherHash] = await Promise.all([bcrypt.hash(directorPassword, 10), bcrypt.hash(teacherPassword, 10)]);
  const schoolYear = schoolYearOf(today);

  const result = await prisma.$transaction(
    async (tx) => {
      const school = await tx.school.create({
        data: { name: 'Institut Mwanga', province: 'NORD_KIVU', epstCode: SEED_EPST_CODE, city: 'Goma', phone: '+243990000100' },
      });

      const users = {};
      users.director = await tx.user.create({
        data: { schoolId: school.id, ...SEED_USERS.director, passwordHash: directorHash, role: 'DIRECTOR' },
      });
      users.teacher1 = await tx.user.create({
        data: { schoolId: school.id, ...SEED_USERS.teacher1, passwordHash: teacherHash, role: 'TEACHER' },
      });
      users.teacher2 = await tx.user.create({
        data: { schoolId: school.id, ...SEED_USERS.teacher2, passwordHash: teacherHash, role: 'TEACHER' },
      });

      await tx.subject.createMany({ data: SUBJECTS.map((s) => ({ ...s, schoolId: school.id })) });

      const classes = {};
      const studentsByClass = {};
      let phoneCounter = 0;
      for (const def of CLASSES) {
        classes[def.key] = await tx.class.create({
          data: {
            schoolId: school.id,
            level: def.level,
            option: def.option,
            section: def.section,
            name: def.name,
            teacherId: users[def.teacher].id,
          },
        });
        const usedNames = new Set();
        const rows = [];
        for (let i = 1; i <= def.size; i += 1) {
          const gender = rand() < 0.5 ? 'M' : 'F';
          let lastName;
          let middleName;
          let firstName;
          do {
            lastName = pick(LAST_NAMES);
            middleName = pick(MIDDLE_NAMES);
            firstName = pick(gender === 'M' ? FIRST_M : FIRST_F);
          } while (usedNames.has(`${lastName}|${middleName}|${firstName}`));
          usedNames.add(`${lastName}|${middleName}|${firstName}`);
          phoneCounter += 1;
          const prefix = GUARDIAN_PREFIXES[phoneCounter % GUARDIAN_PREFIXES.length];
          rows.push({
            id: randomUUID(),
            schoolId: school.id,
            classId: classes[def.key].id,
            lastName,
            middleName,
            firstName,
            gender,
            guardianName: `${pick(['Papa', 'Maman'])} ${lastName}`,
            guardianPhone: `+243${prefix}${String(1000000 + phoneCounter * 7919).slice(-7)}`,
          });
        }
        rows.sort((a, b) => `${a.lastName}${a.middleName}${a.firstName}`.localeCompare(`${b.lastName}${b.middleName}${b.firstName}`, 'fr'));
        rows.forEach((row, index) => {
          row.matricule = `MWG-${schoolYear.slice(0, 4)}-${def.matPrefix}-${String(index + 1).padStart(3, '0')}`;
        });
        await tx.student.createMany({ data: rows });
        studentsByClass[def.key] = rows;
      }
      const allStudents = Object.values(studentsByClass).flat();

      // ---------------------------------------------------------------- Frais
      const feePlans = [
        { feeType: 'INSCRIPTION', label: `Inscription ${schoolYear}`, amountDue: 20, dueDate: addDays(today, -30), paid: () => (rand() < 0.92 ? 20 : 0) },
        {
          feeType: 'FRAIS_SCOLAIRES',
          label: 'Frais scolaires T1',
          amountDue: 60,
          dueDate: addDays(today, -9),
          paid: () => {
            const r = rand();
            if (r < 0.62) return 60;
            if (r < 0.78) return 40;
            if (r < 0.9) return 25;
            return 0;
          },
        },
        { feeType: 'FRAIS_SCOLAIRES', label: 'Frais scolaires T2', amountDue: 60, dueDate: addDays(today, 80), paid: () => (rand() < 0.15 ? 30 : 0) },
      ];

      const fees = [];
      const transactions = [];
      let txCounter = 0;
      for (const student of allStudents) {
        for (const plan of feePlans) {
          const amountPaid = plan.paid();
          const feeId = randomUUID();
          fees.push({
            id: feeId,
            studentId: student.id,
            schoolYear,
            feeType: plan.feeType,
            label: plan.label,
            amountDue: plan.amountDue,
            amountPaid,
            currency: 'USD',
            dueDate: toDbDate(plan.dueDate),
            status: computeFeeStatus(amountPaid, plan.amountDue, plan.dueDate, today),
          });
          if (amountPaid > 0) {
            txCounter += 1;
            const operator = detectOperator(student.guardianPhone);
            const paidOn = addDays(plan.dueDate, -Math.floor(rand() * 10) - 1);
            const prefix = { MPESA: 'MP', ORANGE_MONEY: 'OM', AIRTEL_MONEY: 'AM' }[operator];
            const createdAt = atTime(paidOn < today ? paidOn : addDays(today, -1), 10, Math.floor(rand() * 59));
            transactions.push({
              transactionId: `TX-${paidOn.replaceAll('-', '')}-SEED${String(txCounter).padStart(4, '0')}`,
              operator,
              reference: `${prefix}SEED${String(txCounter).padStart(6, '0')}`,
              payerPhone: student.guardianPhone,
              amount: amountPaid,
              currency: 'USD',
              status: 'SUCCESS',
              studentId: student.id,
              schoolFeeId: feeId,
              webhookReceivedAt: createdAt,
              createdAt,
            });
          }
        }
      }
      await tx.schoolFee.createMany({ data: fees });
      await tx.transaction.createMany({ data: transactions });

      // ------------------------------------------------------------ Présences
      // 5 jours d'historique pour toutes les classes ; aujourd'hui seulement pour les Humanités
      // (le 5e Primaire A reste à faire en direct depuis l'application mobile).
      const attendance = [];
      const smsLogs = [];
      const days = previousSchoolDays(today, 5);
      for (const def of CLASSES) {
        const classDays = def.key === 'p5a' ? days : [...days, today];
        for (const day of classDays) {
          for (const student of studentsByClass[def.key]) {
            const absent = rand() < 0.07;
            const recordedAt = atTime(day, 8, 5 + Math.floor(rand() * 40));
            const smsAt = absent ? new Date(recordedAt.getTime() + 90_000) : null;
            attendance.push({
              id: randomUUID(),
              studentId: student.id,
              classId: classes[def.key].id,
              date: toDbDate(day),
              status: absent ? 'ABSENT' : 'PRESENT',
              clientUpdatedAt: recordedAt,
              recordedById: users[def.teacher].id,
              smsAlertSentAt: smsAt,
            });
            if (absent) {
              smsLogs.push({
                studentId: student.id,
                phone: student.guardianPhone,
                message: absenceMessage(student, day),
                type: 'ABSENCE_ALERT',
                status: 'SENT',
                providerId: `SMS-SEED-${String(smsLogs.length + 1).padStart(5, '0')}`,
                createdAt: smsAt,
              });
            }
          }
        }
      }
      await tx.attendance.createMany({ data: attendance });
      await tx.smsLog.createMany({ data: smsLogs });

      return {
        skipped: false,
        schoolId: school.id,
        counts: {
          students: allStudents.length,
          fees: fees.length,
          insolvent: fees.filter((f) => f.status === 'INSOLVABLE').length,
          transactions: transactions.length,
          attendance: attendance.length,
          absences: smsLogs.length,
        },
      };
    },
    { timeout: 60_000 },
  );

  log(`[seed] Institut Mwanga créé (${schoolYear}) :`, JSON.stringify(result.counts));
  log(`[seed] Directeur  : ${SEED_USERS.director.phone}  (mot de passe : SEED_DIRECTOR_PASSWORD)`);
  log(`[seed] Enseignants: ${SEED_USERS.teacher1.phone}, ${SEED_USERS.teacher2.phone}  (mot de passe : SEED_TEACHER_PASSWORD)`);
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const prisma = new PrismaClient();
  runSeed(prisma)
    .catch((err) => {
      console.error('[seed] Échec :', err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
