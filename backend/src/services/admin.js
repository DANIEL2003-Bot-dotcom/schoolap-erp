import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { badRequest, conflict, forbidden, notFound, parseOrThrow } from '../utils/httpError.js';
import { fromDbDate, isValidIsoDate, schoolYearOf, toDbDate, todayIn } from '../utils/dates.js';
import { normalizeDrcPhone } from '../utils/phone.js';
import { studentFullName } from '../utils/names.js';
import { computeFeeStatus } from './fees.js';

/* =============================================================================
   Gestion administrative : classes, enseignants / personnel, matières, élèves
   (création, modification, transfert, désinscription, import CSV) et frais
   (création groupée par classe, modification, remise, synthèse).
   Toutes les opérations sont strictement limitées à l'école de l'utilisateur.
   ============================================================================= */

export const MAX_IMPORT_ROWS = 1000;
const isUniqueViolation = (e) => e?.code === 'P2002';
const twoDecimals = (v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6;
const round2 = (n) => Math.round(n * 100) / 100;

// ------------------------------------------------------------------ Schémas
const trimmed = (label, max) => z.string({ error: `${label} est obligatoire.` }).trim().min(1, `${label} est obligatoire.`).max(max, `${label} : ${max} caractères maximum.`);
const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));
const phoneField = z
  .string({ error: 'Téléphone obligatoire.' })
  .transform((v, ctx) => {
    const e164 = normalizeDrcPhone(v);
    if (!e164) {
      ctx.addIssue({ code: 'custom', message: 'Numéro RDC invalide (ex : 0970000000 ou +243970000000).' });
      return z.NEVER;
    }
    return e164;
  });
const isoDateField = (label) => z.string({ error: `${label} est obligatoire.` }).refine(isValidIsoDate, `${label} invalide (AAAA-MM-JJ).`);
const moneyField = z.number({ error: 'Montant numérique attendu.' }).min(0, 'Montant négatif interdit.').max(1_000_000_000).refine(twoDecimals, '2 décimales maximum.');

const classSchema = z.object({
  level: trimmed('Le niveau', 60),
  option: optionalText(60),
  section: optionalText(10),
  name: optionalText(120),
  teacherId: z.uuid({ error: 'teacherId invalide.' }).nullish(),
});
const classPatchSchema = classSchema.partial().refine((v) => Object.keys(v).length > 0, 'Aucun champ à modifier.');

const userSchema = z.object({
  fullName: trimmed('Le nom complet', 120),
  phone: phoneField,
  role: z.enum(['TEACHER', 'BURSAR', 'DIRECTOR'], { error: 'Rôle : TEACHER, BURSAR ou DIRECTOR.' }),
  password: z.string({ error: 'Mot de passe obligatoire.' }).min(8, 'Mot de passe : 8 caractères minimum.').max(128),
});
const userPatchSchema = z
  .object({
    fullName: trimmed('Le nom complet', 120).optional(),
    isActive: z.boolean().optional(),
    password: z.string().min(8, 'Mot de passe : 8 caractères minimum.').max(128).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Aucun champ à modifier.');

const subjectSchema = z.object({
  name: trimmed('Le nom de la matière', 80),
  defaultMaxScore: z.number().positive().max(1000).refine(twoDecimals, '2 décimales maximum.').default(20),
});
const subjectPatchSchema = subjectSchema.partial().refine((v) => Object.keys(v).length > 0, 'Aucun champ à modifier.');

const studentBase = {
  lastName: trimmed('Le nom', 60),
  middleName: trimmed('Le postnom', 60),
  firstName: trimmed('Le prénom', 60),
  gender: z.enum(['M', 'F'], { error: 'Sexe : M ou F.' }),
  guardianName: optionalText(120),
  guardianPhone: phoneField,
};
const studentSchema = z.object({
  ...studentBase,
  classId: z.uuid({ error: 'Classe obligatoire.' }),
  matricule: optionalText(40),
  applyClassFees: z.boolean().default(true),
});
const studentPatchSchema = z
  .object({
    lastName: studentBase.lastName.optional(),
    middleName: studentBase.middleName.optional(),
    firstName: studentBase.firstName.optional(),
    gender: studentBase.gender.optional(),
    guardianName: studentBase.guardianName.optional(),
    guardianPhone: studentBase.guardianPhone.optional(),
    classId: z.uuid().optional(),
    matricule: trimmed('Le matricule', 40).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Aucun champ à modifier.');

const listStudentsSchema = z.object({
  classId: z.uuid().optional(),
  q: z.string().trim().max(80).optional(),
  status: z.enum(['active', 'inactive', 'all']).default('active'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const importSchema = z.object({
  classId: z.uuid({ error: 'Classe obligatoire.' }),
  csv: z.string({ error: 'Contenu CSV obligatoire.' }).min(1, 'Fichier CSV vide.').max(900_000, 'Fichier trop volumineux.'),
  dryRun: z.boolean().default(false),
  applyClassFees: z.boolean().default(true),
});

const FEE_TYPES = ['INSCRIPTION', 'MINERVAL', 'FRAIS_SCOLAIRES', 'FRAIS_CONNEXES', 'FRAIS_EXAMEN', 'UNIFORME', 'AUTRE'];
const bulkFeeSchema = z.object({
  classIds: z.array(z.uuid()).min(1, 'Choisissez au moins une classe.').max(200),
  feeType: z.enum(FEE_TYPES, { error: 'Type de frais invalide.' }),
  label: trimmed('Le libellé', 80),
  amountDue: moneyField.refine((v) => v > 0, 'Le montant doit être supérieur à 0.'),
  currency: z.enum(['USD', 'CDF']).default('USD'),
  dueDate: isoDateField('L’échéance'),
  schoolYear: z.string().regex(/^\d{4}-\d{4}$/, 'Année scolaire : AAAA-AAAA.').optional(),
});
const feePatchSchema = z
  .object({
    label: trimmed('Le libellé', 80).optional(),
    amountDue: moneyField.optional(),
    dueDate: isoDateField('L’échéance').optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Aucun champ à modifier.');

// ------------------------------------------------------------------ CSV
const HEADER_ALIASES = {
  nom: 'lastName',
  postnom: 'middleName',
  prenom: 'firstName',
  sexe: 'gender',
  genre: 'gender',
  telephone_tuteur: 'guardianPhone',
  telephone: 'guardianPhone',
  tel_tuteur: 'guardianPhone',
  nom_tuteur: 'guardianName',
  tuteur: 'guardianName',
  matricule: 'matricule',
};
const REQUIRED_COLUMNS = ['lastName', 'middleName', 'firstName', 'gender', 'guardianPhone'];

function normalizeHeader(h) {
  return h
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

/** Découpe une ligne CSV (séparateur ; ou ,) en respectant les guillemets. */
function splitCsvLine(line, sep) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

/** Analyse le CSV d'import d'élèves. Renvoie { rows, errors } avec numéros de ligne du fichier. */
export function parseStudentsCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const firstIdx = lines.findIndex((l) => l.trim() !== '');
  if (firstIdx === -1) return { rows: [], errors: [{ line: 1, message: 'Fichier vide.' }] };
  const headerLine = lines[firstIdx];
  const sep = (headerLine.match(/;/g) ?? []).length >= (headerLine.match(/,/g) ?? []).length ? ';' : ',';
  const columns = splitCsvLine(headerLine, sep).map((h) => HEADER_ALIASES[normalizeHeader(h)] ?? null);
  const missing = REQUIRED_COLUMNS.filter((c) => !columns.includes(c));
  if (missing.length) {
    return {
      rows: [],
      errors: [{ line: firstIdx + 1, message: `Colonnes manquantes : ${missing.join(', ')}. En-tête attendu : nom;postnom;prenom;sexe;telephone_tuteur;nom_tuteur;matricule` }],
    };
  }

  const rows = [];
  const errors = [];
  for (let i = firstIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const values = splitCsvLine(lines[i], sep);
    const raw = {};
    columns.forEach((c, idx) => {
      if (c) raw[c] = values[idx] ?? '';
    });
    if (typeof raw.gender === 'string') {
      const g = raw.gender.trim().toUpperCase();
      raw.gender = g.startsWith('F') ? 'F' : g.startsWith('M') || g.startsWith('G') ? 'M' : g;
    }
    const parsed = z.object({ ...studentBase, matricule: optionalText(40) }).safeParse(raw);
    if (!parsed.success) {
      errors.push({ line: i + 1, message: parsed.error.issues.map((x) => x.message).join(' · ') });
    } else {
      rows.push({ line: i + 1, ...parsed.data });
    }
  }
  if (rows.length + errors.length > MAX_IMPORT_ROWS) {
    return { rows: [], errors: [{ line: 0, message: `Maximum ${MAX_IMPORT_ROWS} élèves par import.` }] };
  }
  if (rows.length + errors.length === 0) errors.push({ line: firstIdx + 2, message: 'Aucun élève dans le fichier.' });
  return { rows, errors };
}

// ------------------------------------------------------------------ Service
export function createAdminService({ prisma, config }) {
  const today = () => todayIn(config.timezone);

  async function getClassOrThrow(user, classId) {
    const cls = await prisma.class.findFirst({ where: { id: classId, schoolId: user.schoolId } });
    if (!cls) throw notFound('Classe introuvable.');
    return cls;
  }

  async function assertTeacher(user, teacherId) {
    if (!teacherId) return;
    const t = await prisma.user.findFirst({ where: { id: teacherId, schoolId: user.schoolId, role: 'TEACHER', isActive: true } });
    if (!t) throw badRequest('Titulaire invalide : choisissez un enseignant actif de l’école.');
  }

  function className({ level, option, section }) {
    return [level, option, section].filter(Boolean).join(' ');
  }

  /** Matricule automatique : <année>-<code EPST court>-<n° sur 5 chiffres>, unique. */
  async function nextMatricule(db, schoolId) {
    const school = await db.school.findUnique({ where: { id: schoolId }, select: { epstCode: true } });
    const code = (school.epstCode.split('-').pop() || 'ECO').toUpperCase();
    const prefix = `${today().slice(0, 4)}-${code}-`;
    const last = await db.student.findFirst({ where: { matricule: { startsWith: prefix } }, orderBy: { matricule: 'desc' }, select: { matricule: true } });
    let n = last ? Number(last.matricule.slice(prefix.length)) || 0 : 0;
    return () => `${prefix}${String(++n).padStart(5, '0')}`;
  }

  /** Frais « modèles » de la classe pour l'année en cours (ceux déjà portés par les élèves actifs). */
  async function classFeeTemplates(db, classId, excludeStudentIds = []) {
    const schoolYear = schoolYearOf(today());
    const rows = await db.schoolFee.groupBy({
      by: ['feeType', 'label', 'amountDue', 'currency', 'dueDate'],
      where: { schoolYear, student: { classId, isActive: true, id: { notIn: excludeStudentIds } } },
      _count: { _all: true },
    });
    // Un même (type, libellé) peut avoir plusieurs montants (remises) : on garde le plus fréquent.
    const best = new Map();
    for (const r of rows) {
      const key = `${r.feeType}|${r.label}`;
      if (!best.has(key) || best.get(key)._count._all < r._count._all) best.set(key, r);
    }
    return [...best.values()].map((r) => ({ schoolYear, feeType: r.feeType, label: r.label, amountDue: r.amountDue, currency: r.currency, dueDate: r.dueDate }));
  }

  function feeRowsFor(studentIds, templates) {
    const t = today();
    return studentIds.flatMap((studentId) =>
      templates.map((f) => ({
        studentId,
        schoolYear: f.schoolYear,
        feeType: f.feeType,
        label: f.label,
        amountDue: f.amountDue,
        amountPaid: 0,
        currency: f.currency,
        dueDate: f.dueDate,
        status: computeFeeStatus(0, f.amountDue, fromDbDate(f.dueDate), t),
      })),
    );
  }

  const studentOut = (s) => ({
    id: s.id,
    matricule: s.matricule,
    lastName: s.lastName,
    middleName: s.middleName,
    firstName: s.firstName,
    fullName: studentFullName(s),
    gender: s.gender,
    guardianName: s.guardianName,
    guardianPhone: s.guardianPhone,
    classId: s.classId,
    className: s.class?.name ?? null,
    isActive: s.isActive,
    createdAt: s.createdAt.toISOString(),
  });

  const feeOut = (f) => ({
    id: f.id,
    schoolYear: f.schoolYear,
    feeType: f.feeType,
    label: f.label,
    amountDue: Number(f.amountDue),
    amountPaid: Number(f.amountPaid),
    remaining: round2(Number(f.amountDue) - Number(f.amountPaid)),
    currency: f.currency,
    dueDate: fromDbDate(f.dueDate),
    status: f.status,
    lastReminderAt: f.lastReminderAt?.toISOString() ?? null,
  });

  return {
    // =========================================================== Référentiel
    async overview(user) {
      const [classes, staff, subjects] = await Promise.all([
        prisma.class.findMany({
          where: { schoolId: user.schoolId },
          orderBy: { name: 'asc' },
          include: { teacher: { select: { id: true, fullName: true } }, _count: { select: { students: { where: { isActive: true } } } } },
        }),
        prisma.user.findMany({
          where: { schoolId: user.schoolId },
          orderBy: [{ role: 'asc' }, { fullName: 'asc' }],
          select: { id: true, fullName: true, phone: true, role: true, isActive: true, _count: { select: { classesTaught: true } } },
        }),
        prisma.subject.findMany({ where: { schoolId: user.schoolId }, orderBy: { name: 'asc' } }),
      ]);
      return {
        classes: classes.map((c) => ({
          id: c.id,
          name: c.name,
          level: c.level,
          option: c.option,
          section: c.section,
          teacherId: c.teacherId,
          teacherName: c.teacher?.fullName ?? null,
          studentCount: c._count.students,
        })),
        staff: staff.map((u) => ({ id: u.id, fullName: u.fullName, phone: u.phone, role: u.role, isActive: u.isActive, classCount: u._count.classesTaught })),
        subjects: subjects.map((s) => ({ id: s.id, name: s.name, defaultMaxScore: Number(s.defaultMaxScore) })),
      };
    },

    // =============================================================== Classes
    async createClass(user, body) {
      const input = parseOrThrow(classSchema, body, 'Classe invalide.');
      await assertTeacher(user, input.teacherId);
      try {
        const c = await prisma.class.create({
          data: {
            schoolId: user.schoolId,
            level: input.level,
            option: input.option,
            section: input.section,
            name: input.name ?? className(input),
            teacherId: input.teacherId ?? null,
          },
        });
        return { class: c };
      } catch (e) {
        if (isUniqueViolation(e)) throw conflict('Une classe porte déjà ce nom.');
        throw e;
      }
    },

    async updateClass(user, classId, body) {
      const input = parseOrThrow(classPatchSchema, body, 'Modification invalide.');
      const current = await getClassOrThrow(user, classId);
      if (input.teacherId !== undefined) await assertTeacher(user, input.teacherId);
      const merged = { level: input.level ?? current.level, option: input.option !== undefined ? input.option : current.option, section: input.section !== undefined ? input.section : current.section };
      const renamedParts = input.level !== undefined || input.option !== undefined || input.section !== undefined;
      const autoName = current.name === className(current);
      try {
        const c = await prisma.class.update({
          where: { id: classId },
          data: {
            ...merged,
            name: input.name ?? (renamedParts && autoName ? className(merged) : current.name),
            ...(input.teacherId !== undefined ? { teacherId: input.teacherId } : {}),
          },
        });
        return { class: c };
      } catch (e) {
        if (isUniqueViolation(e)) throw conflict('Une classe porte déjà ce nom.');
        throw e;
      }
    },

    async deleteClass(user, classId) {
      await getClassOrThrow(user, classId);
      const count = await prisma.student.count({ where: { classId } });
      if (count > 0) throw conflict(`Impossible de supprimer : ${count} élève(s) sont rattachés à cette classe. Transférez-les d’abord.`);
      await prisma.class.delete({ where: { id: classId } });
      return { deleted: true };
    },

    // ============================================================ Personnel
    async createUser(user, body) {
      const input = parseOrThrow(userSchema, body, 'Compte invalide.');
      if (input.role === 'DIRECTOR' && user.role !== 'ADMIN' && user.role !== 'DIRECTOR') throw forbidden('Rôle non autorisé.');
      try {
        const created = await prisma.user.create({
          data: { schoolId: user.schoolId, fullName: input.fullName, phone: input.phone, role: input.role, passwordHash: await bcrypt.hash(input.password, 10) },
          select: { id: true, fullName: true, phone: true, role: true, isActive: true },
        });
        return { user: created };
      } catch (e) {
        if (isUniqueViolation(e)) throw conflict('Ce numéro de téléphone est déjà utilisé par un compte.');
        throw e;
      }
    },

    async updateUser(user, userId, body) {
      const input = parseOrThrow(userPatchSchema, body, 'Modification invalide.');
      const target = await prisma.user.findFirst({ where: { id: userId, schoolId: user.schoolId } });
      if (!target) throw notFound('Compte introuvable.');
      if (target.id === user.id && input.isActive === false) throw badRequest('Vous ne pouvez pas désactiver votre propre compte.');
      if (target.role === 'ADMIN' && user.role !== 'ADMIN') throw forbidden('Seul un administrateur peut modifier ce compte.');
      const updated = await prisma.$transaction(async (db) => {
        const u = await db.user.update({
          where: { id: userId },
          data: {
            ...(input.fullName ? { fullName: input.fullName } : {}),
            ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
            ...(input.password ? { passwordHash: await bcrypt.hash(input.password, 10) } : {}),
          },
          select: { id: true, fullName: true, phone: true, role: true, isActive: true },
        });
        // Un enseignant désactivé libère ses classes (qui apparaissent « sans titulaire »).
        if (input.isActive === false && target.role === 'TEACHER') await db.class.updateMany({ where: { teacherId: userId }, data: { teacherId: null } });
        return u;
      });
      return { user: updated };
    },

    // ============================================================= Matières
    async createSubject(user, body) {
      const input = parseOrThrow(subjectSchema, body, 'Matière invalide.');
      try {
        const s = await prisma.subject.create({ data: { schoolId: user.schoolId, ...input } });
        return { subject: { id: s.id, name: s.name, defaultMaxScore: Number(s.defaultMaxScore) } };
      } catch (e) {
        if (isUniqueViolation(e)) throw conflict('Cette matière existe déjà.');
        throw e;
      }
    },

    async updateSubject(user, subjectId, body) {
      const input = parseOrThrow(subjectPatchSchema, body, 'Modification invalide.');
      const s = await prisma.subject.findFirst({ where: { id: subjectId, schoolId: user.schoolId } });
      if (!s) throw notFound('Matière introuvable.');
      try {
        const u = await prisma.subject.update({ where: { id: subjectId }, data: input });
        return { subject: { id: u.id, name: u.name, defaultMaxScore: Number(u.defaultMaxScore) } };
      } catch (e) {
        if (isUniqueViolation(e)) throw conflict('Cette matière existe déjà.');
        throw e;
      }
    },

    // =============================================================== Élèves
    async listStudents(user, query) {
      const q = parseOrThrow(listStudentsSchema, query, 'Filtre invalide.');
      const where = {
        schoolId: user.schoolId,
        ...(q.classId ? { classId: q.classId } : {}),
        ...(q.status === 'all' ? {} : { isActive: q.status === 'active' }),
        ...(q.q
          ? {
              OR: [
                { lastName: { contains: q.q, mode: 'insensitive' } },
                { middleName: { contains: q.q, mode: 'insensitive' } },
                { firstName: { contains: q.q, mode: 'insensitive' } },
                { matricule: { contains: q.q, mode: 'insensitive' } },
                { guardianPhone: { contains: q.q.replace(/\s/g, '') } },
              ],
            }
          : {}),
      };
      const [total, rows] = await Promise.all([
        prisma.student.count({ where }),
        prisma.student.findMany({
          where,
          orderBy: [{ lastName: 'asc' }, { middleName: 'asc' }, { firstName: 'asc' }],
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
          include: { class: { select: { name: true } } },
        }),
      ]);
      // Solde restant dû par élève (année en cours), pour la colonne « Reste à payer »
      const balances = await prisma.schoolFee.groupBy({
        by: ['studentId'],
        where: { studentId: { in: rows.map((r) => r.id) }, schoolYear: schoolYearOf(today()) },
        _sum: { amountDue: true, amountPaid: true },
      });
      const balanceMap = new Map(balances.map((b) => [b.studentId, round2(Number(b._sum.amountDue ?? 0) - Number(b._sum.amountPaid ?? 0))]));
      return {
        total,
        page: q.page,
        pageSize: q.pageSize,
        students: rows.map((s) => ({ ...studentOut(s), outstanding: balanceMap.get(s.id) ?? 0 })),
      };
    },

    async getStudent(user, studentId) {
      const s = await prisma.student.findFirst({
        where: { id: studentId, schoolId: user.schoolId },
        include: {
          class: { select: { name: true } },
          fees: { orderBy: [{ schoolYear: 'desc' }, { dueDate: 'asc' }] },
          transactions: { orderBy: { createdAt: 'desc' }, take: 20 },
        },
      });
      if (!s) throw notFound('Élève introuvable.');
      const [present, absent] = await Promise.all([
        prisma.attendance.count({ where: { studentId, status: 'PRESENT' } }),
        prisma.attendance.count({ where: { studentId, status: 'ABSENT' } }),
      ]);
      return {
        student: studentOut(s),
        attendance: { present, absent, rate: present + absent > 0 ? present / (present + absent) : null },
        fees: s.fees.map(feeOut),
        transactions: s.transactions.map((t) => ({
          transactionId: t.transactionId,
          operator: t.operator,
          amount: Number(t.amount),
          currency: t.currency,
          status: t.status,
          failureReason: t.failureReason,
          createdAt: t.createdAt.toISOString(),
        })),
      };
    },

    async createStudent(user, body) {
      const input = parseOrThrow(studentSchema, body, 'Élève invalide.');
      await getClassOrThrow(user, input.classId);
      try {
        return await prisma.$transaction(async (db) => {
          const gen = await nextMatricule(db, user.schoolId);
          const student = await db.student.create({
            data: {
              schoolId: user.schoolId,
              classId: input.classId,
              matricule: input.matricule ?? gen(),
              lastName: input.lastName,
              middleName: input.middleName,
              firstName: input.firstName,
              gender: input.gender,
              guardianName: input.guardianName,
              guardianPhone: input.guardianPhone,
            },
            include: { class: { select: { name: true } } },
          });
          let feesCreated = 0;
          if (input.applyClassFees) {
            const templates = await classFeeTemplates(db, input.classId, [student.id]);
            feesCreated = (await db.schoolFee.createMany({ data: feeRowsFor([student.id], templates), skipDuplicates: true })).count;
          }
          return { student: studentOut(student), feesCreated };
        });
      } catch (e) {
        if (isUniqueViolation(e)) throw conflict('Ce matricule est déjà attribué à un autre élève.');
        throw e;
      }
    },

    async updateStudent(user, studentId, body) {
      const input = parseOrThrow(studentPatchSchema, body, 'Modification invalide.');
      const s = await prisma.student.findFirst({ where: { id: studentId, schoolId: user.schoolId } });
      if (!s) throw notFound('Élève introuvable.');
      if (input.classId && input.classId !== s.classId) await getClassOrThrow(user, input.classId);
      try {
        const updated = await prisma.student.update({ where: { id: studentId }, data: input, include: { class: { select: { name: true } } } });
        return { student: studentOut(updated) };
      } catch (e) {
        if (isUniqueViolation(e)) throw conflict('Ce matricule est déjà attribué à un autre élève.');
        throw e;
      }
    },

    async importStudents(user, body) {
      const input = parseOrThrow(importSchema, body, 'Import invalide.');
      await getClassOrThrow(user, input.classId);
      const { rows, errors } = parseStudentsCsv(input.csv);

      // Doublons dans le fichier et matricules déjà pris en base
      const seen = new Map();
      for (const r of rows) {
        if (!r.matricule) continue;
        if (seen.has(r.matricule)) errors.push({ line: r.line, message: `Matricule ${r.matricule} en double (ligne ${seen.get(r.matricule)}).` });
        else seen.set(r.matricule, r.line);
      }
      if (seen.size) {
        const taken = await prisma.student.findMany({ where: { matricule: { in: [...seen.keys()] } }, select: { matricule: true } });
        for (const t of taken) errors.push({ line: seen.get(t.matricule), message: `Matricule ${t.matricule} déjà attribué.` });
      }
      errors.sort((a, b) => a.line - b.line);

      const preview = rows.slice(0, 20).map((r) => ({ line: r.line, fullName: studentFullName(r), gender: r.gender, guardianPhone: r.guardianPhone, matricule: r.matricule }));
      if (errors.length) throw badRequest(`${errors.length} ligne(s) invalide(s) : corrigez le fichier puis réessayez. Aucun élève n’a été importé.`, { errors, valid: rows.length });
      if (input.dryRun) return { dryRun: true, valid: rows.length, preview };

      const result = await prisma.$transaction(
        async (db) => {
          const gen = await nextMatricule(db, user.schoolId);
          const data = rows.map((r) => ({
            schoolId: user.schoolId,
            classId: input.classId,
            matricule: r.matricule ?? gen(),
            lastName: r.lastName,
            middleName: r.middleName,
            firstName: r.firstName,
            gender: r.gender,
            guardianName: r.guardianName,
            guardianPhone: r.guardianPhone,
          }));
          const created = await db.student.createManyAndReturn({ data, select: { id: true } });
          let feesCreated = 0;
          if (input.applyClassFees) {
            const templates = await classFeeTemplates(db, input.classId, created.map((c) => c.id));
            feesCreated = (await db.schoolFee.createMany({ data: feeRowsFor(created.map((c) => c.id), templates), skipDuplicates: true })).count;
          }
          return { imported: created.length, feesCreated };
        },
        { timeout: 60_000 },
      );
      return { dryRun: false, ...result, preview };
    },

    // ================================================================ Frais
    async feeSummary(user) {
      const schoolYear = schoolYearOf(today());
      const groups = await prisma.schoolFee.groupBy({
        by: ['feeType', 'label', 'currency', 'dueDate'],
        where: { schoolYear, student: { schoolId: user.schoolId, isActive: true } },
        _sum: { amountDue: true, amountPaid: true },
        _count: { _all: true },
        orderBy: [{ dueDate: 'asc' }, { label: 'asc' }],
      });
      const statusCounts = await prisma.schoolFee.groupBy({
        by: ['feeType', 'label', 'currency', 'dueDate', 'status'],
        where: { schoolYear, student: { schoolId: user.schoolId, isActive: true } },
        _count: { _all: true },
      });
      const key = (g) => `${g.feeType}|${g.label}|${g.currency}|${fromDbDate(g.dueDate)}`;
      const byStatus = new Map();
      for (const s of statusCounts) {
        const k = key(s);
        byStatus.set(k, { ...(byStatus.get(k) ?? {}), [s.status]: s._count._all });
      }
      return {
        schoolYear,
        plans: groups.map((g) => {
          const due = Number(g._sum.amountDue ?? 0);
          const paid = Number(g._sum.amountPaid ?? 0);
          const st = byStatus.get(key(g)) ?? {};
          return {
            feeType: g.feeType,
            label: g.label,
            currency: g.currency,
            dueDate: fromDbDate(g.dueDate),
            students: g._count._all,
            due: round2(due),
            paid: round2(paid),
            recoveryRate: due > 0 ? paid / due : null,
            solde: st.SOLDE ?? 0,
            enCours: st.EN_COURS ?? 0,
            insolvable: st.INSOLVABLE ?? 0,
          };
        }),
      };
    },

    /** Crée un frais pour tous les élèves actifs des classes choisies (idempotent). */
    async bulkCreateFees(user, body) {
      const input = parseOrThrow(bulkFeeSchema, body, 'Frais invalide.');
      const classes = await prisma.class.findMany({ where: { id: { in: input.classIds }, schoolId: user.schoolId }, select: { id: true } });
      if (classes.length !== new Set(input.classIds).size) throw badRequest('Une ou plusieurs classes sont introuvables.');
      const students = await prisma.student.findMany({ where: { classId: { in: input.classIds }, isActive: true }, select: { id: true } });
      if (students.length === 0) throw badRequest('Aucun élève actif dans les classes choisies.');
      const schoolYear = input.schoolYear ?? schoolYearOf(today());
      const rows = feeRowsFor(
        students.map((s) => s.id),
        [{ schoolYear, feeType: input.feeType, label: input.label, amountDue: input.amountDue, currency: input.currency, dueDate: toDbDate(input.dueDate) }],
      );
      const { count } = await prisma.schoolFee.createMany({ data: rows, skipDuplicates: true });
      return { created: count, skipped: rows.length - count, students: students.length };
    },

    /** Modifie un frais (remise, report d'échéance). Le montant dû ne peut pas passer sous le déjà payé. */
    async updateFee(user, feeId, body) {
      const input = parseOrThrow(feePatchSchema, body, 'Modification invalide.');
      const fee = await prisma.schoolFee.findFirst({ where: { id: feeId, student: { schoolId: user.schoolId } } });
      if (!fee) throw notFound('Frais introuvable.');
      if (input.amountDue !== undefined && input.amountDue < Number(fee.amountPaid)) {
        throw badRequest(`Le montant dû ne peut pas être inférieur au montant déjà payé (${Number(fee.amountPaid).toFixed(2)}).`);
      }
      const amountDue = input.amountDue ?? Number(fee.amountDue);
      const dueDate = input.dueDate ?? fromDbDate(fee.dueDate);
      try {
        const updated = await prisma.schoolFee.update({
          where: { id: feeId },
          data: {
            ...(input.label ? { label: input.label } : {}),
            amountDue,
            dueDate: toDbDate(dueDate),
            status: computeFeeStatus(fee.amountPaid, amountDue, dueDate, today()),
          },
        });
        return { fee: feeOut(updated) };
      } catch (e) {
        if (isUniqueViolation(e)) throw conflict('Cet élève a déjà un frais portant ce libellé.');
        throw e;
      }
    },
  };
}
