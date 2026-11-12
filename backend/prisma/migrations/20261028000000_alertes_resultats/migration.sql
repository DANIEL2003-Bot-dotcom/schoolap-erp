-- Alertes de baisse des résultats (moyennes, chutes, échecs consécutifs) + SMS aux tuteurs

-- CreateEnum
CREATE TYPE "AlertSignal" AS ENUM ('ECHECS_CONSECUTIFS', 'FAIBLE', 'CHUTE');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('ACTIVE', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "AlertSmsStatus" AS ENUM ('SENT', 'SKIPPED_RECENT');

-- AlterEnum
ALTER TYPE "SmsType" ADD VALUE 'PERFORMANCE_ALERT';

-- CreateTable
CREATE TABLE "performance_alerts" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "subject_id" UUID,
    "term" "Term" NOT NULL,
    "signals" "AlertSignal"[],
    "status" "AlertStatus" NOT NULL DEFAULT 'ACTIVE',
    "average_pct" DECIMAL(5,2),
    "last_pct" DECIMAL(5,2),
    "reference_pct" DECIMAL(5,2),
    "summary" TEXT NOT NULL,
    "sms_status" "AlertSmsStatus",
    "sms_sent_at" TIMESTAMP(3),
    "acknowledged_by_id" UUID,
    "acknowledged_at" TIMESTAMP(3),
    "note" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "performance_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "performance_alerts_school_id_status_idx" ON "performance_alerts"("school_id", "status");

-- CreateIndex
CREATE INDEX "performance_alerts_student_id_status_idx" ON "performance_alerts"("student_id", "status");

-- AddForeignKey
ALTER TABLE "performance_alerts" ADD CONSTRAINT "performance_alerts_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_alerts" ADD CONSTRAINT "performance_alerts_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_alerts" ADD CONSTRAINT "performance_alerts_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_alerts" ADD CONSTRAINT "performance_alerts_acknowledged_by_id_fkey" FOREIGN KEY ("acknowledged_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Une seule alerte ouverte (ACTIVE ou ACKNOWLEDGED) par élève et par matière ;
-- subject_id vide = moyenne générale. Index partiel : non exprimable dans le schéma Prisma.
CREATE UNIQUE INDEX "performance_alerts_open_key"
  ON "performance_alerts" ("student_id", COALESCE("subject_id", '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE "status" <> 'RESOLVED';
