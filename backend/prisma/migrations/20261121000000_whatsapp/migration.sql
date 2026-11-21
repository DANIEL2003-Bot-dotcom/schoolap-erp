-- Canal WhatsApp pour les messages aux tuteurs : suivi de distribution, échecs à traiter, accord du tuteur.
-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('SMS', 'WHATSAPP');

-- AlterEnum : accusés de réception et de lecture WhatsApp ; échec d'une alerte de résultats
-- (PostgreSQL 12+ : plusieurs ADD VALUE dans la même migration, valeurs non utilisées ici)
ALTER TYPE "SmsStatus" ADD VALUE 'DELIVERED';
ALTER TYPE "SmsStatus" ADD VALUE 'READ';
ALTER TYPE "AlertSmsStatus" ADD VALUE 'FAILED';

-- AlterTable
ALTER TABLE "sms_logs" ADD COLUMN     "channel" "MessageChannel" NOT NULL DEFAULT 'SMS',
ADD COLUMN     "delivered_at" TIMESTAMP(3),
ADD COLUMN     "error" TEXT,
ADD COLUMN     "handled_at" TIMESTAMP(3),
ADD COLUMN     "handled_by_id" UUID,
ADD COLUMN     "read_at" TIMESTAMP(3),
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "students" ADD COLUMN     "guardian_whatsapp" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "sms_logs_provider_id_idx" ON "sms_logs"("provider_id");

-- CreateIndex
CREATE INDEX "sms_logs_status_created_at_idx" ON "sms_logs"("status", "created_at");

-- AddForeignKey
ALTER TABLE "sms_logs" ADD CONSTRAINT "sms_logs_handled_by_id_fkey" FOREIGN KEY ("handled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
