-- =============================================================================
-- Structure administrative EPST (RDC) : bureaux et rôles du personnel
--   * nouveaux rôles : PREFET, DIRECTEUR_ETUDES (D.E.), DIRECTEUR_DISCIPLINE (D.D.)
--   * table offices : Direction, Études / Préfecture, Discipline,
--     Comptabilité / Caisse, Salle des professeurs (5 bureaux par école)
--   * users.office_id : rattachement de chaque membre du personnel à un bureau
-- Les nouvelles valeurs d'enum ne sont pas utilisées dans cette migration
-- (contrainte PostgreSQL), l'affectation se fait d'après les rôles existants.
-- =============================================================================

-- CreateEnum
CREATE TYPE "OfficeCode" AS ENUM ('DIRECTION', 'ETUDES', 'DISCIPLINE', 'COMPTABILITE', 'SALLE_DES_PROFS');

-- AlterEnum

ALTER TYPE "UserRole" ADD VALUE 'PREFET';
ALTER TYPE "UserRole" ADD VALUE 'DIRECTEUR_ETUDES';
ALTER TYPE "UserRole" ADD VALUE 'DIRECTEUR_DISCIPLINE';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "office_id" UUID;

-- CreateTable
CREATE TABLE "offices" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "code" "OfficeCode" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "offices_school_id_code_key" ON "offices"("school_id", "code");

-- CreateIndex
CREATE INDEX "users_office_id_idx" ON "users"("office_id");

-- AddForeignKey
ALTER TABLE "offices" ADD CONSTRAINT "offices_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Données : 5 bureaux pour chaque école existante
INSERT INTO "offices" ("id", "school_id", "code", "name", "description", "created_at", "updated_at")
SELECT gen_random_uuid(), s."id", o.code::"OfficeCode", o.name, o.description, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "schools" s
CROSS JOIN (VALUES
  ('DIRECTION', 'Direction', 'Chef d’établissement, administration générale et relations avec la sous-division EPST.'),
  ('ETUDES', 'Études / Préfecture', 'Préfet et Directeur des études : programmes, horaires, évaluations, bulletins.'),
  ('DISCIPLINE', 'Discipline', 'Directeur de discipline : assiduité, retards, sanctions, suivi des élèves.'),
  ('COMPTABILITE', 'Comptabilité / Caisse', 'Comptable : frais scolaires, encaissements Mobile Money, relances.'),
  ('SALLE_DES_PROFS', 'Salle des professeurs', 'Enseignants : appel journalier et saisie des cotes.')
) AS o(code, name, description)
ON CONFLICT ("school_id", "code") DO NOTHING;

-- Données : rattachement du personnel existant à son bureau
UPDATE "users" u
SET "office_id" = o."id"
FROM "offices" o
WHERE o."school_id" = u."school_id"
  AND u."office_id" IS NULL
  AND o."code" = (CASE u."role"::text
                    WHEN 'TEACHER' THEN 'SALLE_DES_PROFS'
                    WHEN 'BURSAR' THEN 'COMPTABILITE'
                    ELSE 'DIRECTION'
                  END)::"OfficeCode";
