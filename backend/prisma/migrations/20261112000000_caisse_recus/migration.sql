-- Caisse : encaissements manuels (espèces, banque, Mobile Money reçu sur le téléphone de l'école),
-- reçus numérotés par école et par année, impression (duplicata) et annulation par la direction.

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('MOBILE_MONEY', 'CASH', 'BANK', 'MOBILE_MONEY_DIRECT');

-- AlterEnum
ALTER TYPE "TransactionStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "bank_name" TEXT,
ADD COLUMN     "cancel_reason" TEXT,
ADD COLUMN     "cancelled_at" TIMESTAMP(3),
ADD COLUMN     "cancelled_by_id" UUID,
ADD COLUMN     "client_request_id" UUID,
ADD COLUMN     "external_ref" TEXT,
ADD COLUMN     "fee_balance_after" DECIMAL(12,2),
ADD COLUMN     "method" "PaymentMethod" NOT NULL DEFAULT 'MOBILE_MONEY',
ADD COLUMN     "note" TEXT,
ADD COLUMN     "paid_at" TIMESTAMP(3),
ADD COLUMN     "payer_name" TEXT,
ADD COLUMN     "print_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "receipt_number" TEXT,
ADD COLUMN     "recorded_by_id" UUID,
ALTER COLUMN "operator" DROP NOT NULL,
ALTER COLUMN "payer_phone" DROP NOT NULL;

-- CreateTable
CREATE TABLE "receipt_counters" (
    "school_id" UUID NOT NULL,
    "school_year" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receipt_counters_pkey" PRIMARY KEY ("school_id","school_year")
);

-- CreateIndex
CREATE UNIQUE INDEX "transactions_client_request_id_key" ON "transactions"("client_request_id");

-- CreateIndex
CREATE INDEX "transactions_paid_at_idx" ON "transactions"("paid_at");

-- CreateIndex
CREATE INDEX "transactions_receipt_number_idx" ON "transactions"("receipt_number");

-- CreateIndex
CREATE INDEX "transactions_external_ref_idx" ON "transactions"("external_ref");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_counters" ADD CONSTRAINT "receipt_counters_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Reprise : les paiements Mobile Money déjà confirmés entrent dans le journal de caisse à leur date de confirmation.
UPDATE "transactions" SET "paid_at" = COALESCE("webhook_received_at", "created_at") WHERE "status" = 'SUCCESS' AND "paid_at" IS NULL;

-- Bureau Comptabilité : description alignée sur les nouvelles attributions du comptable.
UPDATE "offices" SET "description" = 'Comptable : encaissements (espèces, banque, Mobile Money), reçus, journal de caisse, relances.', "updated_at" = CURRENT_TIMESTAMP WHERE "code" = 'COMPTABILITE';
