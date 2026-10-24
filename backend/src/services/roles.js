/* =============================================================================
   Structure administrative officielle d'un établissement EPST (RDC)
   - Bureaux : Direction, Études (Préfecture), Discipline, Comptabilité / Caisse,
     Salle des professeurs
   - Rôles   : Préfet des études, Directeur des études (D.E.), Directeur de
     discipline (D.D.), Comptable, Enseignant (+ Directeur et Administrateur)
   - Permissions : une seule source de vérité, utilisée par toutes les routes.
   ============================================================================= */

export const OFFICES = [
  { code: 'DIRECTION', name: 'Direction', description: 'Chef d’établissement, administration générale et relations avec la sous-division EPST.' },
  { code: 'ETUDES', name: 'Études / Préfecture', description: 'Préfet et Directeur des études : programmes, horaires, évaluations, bulletins.' },
  { code: 'DISCIPLINE', name: 'Discipline', description: 'Directeur de discipline : assiduité, retards, sanctions, suivi des élèves.' },
  { code: 'COMPTABILITE', name: 'Comptabilité / Caisse', description: 'Comptable : frais scolaires, encaissements Mobile Money, relances.' },
  { code: 'SALLE_DES_PROFS', name: 'Salle des professeurs', description: 'Enseignants : appel journalier et saisie des cotes.' },
];
export const OFFICE_CODES = OFFICES.map((o) => o.code);

export const ROLES = {
  ADMIN: { label: 'Administrateur', short: 'Admin', office: 'DIRECTION' },
  PREFET: { label: 'Préfet des études', short: 'Préfet', office: 'ETUDES' },
  DIRECTOR: { label: 'Directeur', short: 'Directeur', office: 'DIRECTION' },
  DIRECTEUR_ETUDES: { label: 'Directeur des études', short: 'D.E.', office: 'ETUDES' },
  DIRECTEUR_DISCIPLINE: { label: 'Directeur de discipline', short: 'D.D.', office: 'DISCIPLINE' },
  BURSAR: { label: 'Comptable', short: 'Comptable', office: 'COMPTABILITE' },
  TEACHER: { label: 'Enseignant', short: 'Enseignant', office: 'SALLE_DES_PROFS' },
};
export const ROLE_CODES = Object.keys(ROLES);

/** Capacités → rôles autorisés. */
export const PERMISSIONS = {
  /** Créer / modifier / désactiver les comptes du personnel. */
  MANAGE_STAFF: ['ADMIN', 'PREFET', 'DIRECTOR'],
  /** Classes, titulaires, matières. */
  MANAGE_ACADEMIC: ['ADMIN', 'PREFET', 'DIRECTOR', 'DIRECTEUR_ETUDES'],
  /** Inscriptions, transferts, désinscriptions, import CSV. */
  MANAGE_STUDENTS: ['ADMIN', 'PREFET', 'DIRECTOR', 'DIRECTEUR_ETUDES', 'BURSAR'],
  /** Frais, remises, relances SMS, encaissements Mobile Money. */
  MANAGE_FEES: ['ADMIN', 'PREFET', 'DIRECTOR', 'BURSAR'],
  /** Tableau de bord et consultation des listes (élèves, classes, personnel, frais). */
  VIEW_SCHOOL: ['ADMIN', 'PREFET', 'DIRECTOR', 'DIRECTEUR_ETUDES', 'DIRECTEUR_DISCIPLINE', 'BURSAR'],
  /** Application mobile : chargement des classes et appel. */
  TAKE_ATTENDANCE: ['TEACHER', 'ADMIN', 'PREFET', 'DIRECTOR', 'DIRECTEUR_ETUDES', 'DIRECTEUR_DISCIPLINE'],
  /** Application mobile : saisie des cotes. */
  ENTER_GRADES: ['TEACHER', 'ADMIN', 'PREFET', 'DIRECTOR', 'DIRECTEUR_ETUDES'],
};

export const can = (role, permission) => PERMISSIONS[permission].includes(role);

/** Rôles qu'un gestionnaire peut attribuer : seul un administrateur crée un administrateur. */
export function assignableRoles(actorRole) {
  if (!can(actorRole, 'MANAGE_STAFF')) return [];
  return ROLE_CODES.filter((r) => r !== 'ADMIN' || actorRole === 'ADMIN');
}

export const defaultOfficeFor = (role) => ROLES[role]?.office ?? 'SALLE_DES_PROFS';

/** Crée les 5 bureaux d'une école s'ils n'existent pas (idempotent). */
export async function ensureOffices(db, schoolId) {
  await db.office.createMany({
    data: OFFICES.map((o) => ({ schoolId, code: o.code, name: o.name, description: o.description })),
    skipDuplicates: true,
  });
  return db.office.findMany({ where: { schoolId }, orderBy: { code: 'asc' } });
}

/** Robustesse du mot de passe du personnel : 8 caractères minimum, au moins une lettre et un chiffre. */
export const PASSWORD_RULE = { min: 8, max: 128, pattern: /^(?=.*[A-Za-zÀ-ÿ])(?=.*\d).+$/ };
export const PASSWORD_MESSAGE = 'Mot de passe : 8 caractères minimum, avec au moins une lettre et un chiffre.';
/** Coût bcrypt (2^12 itérations) pour les comptes créés ou modifiés par l'administration. */
export const BCRYPT_COST = 12;
