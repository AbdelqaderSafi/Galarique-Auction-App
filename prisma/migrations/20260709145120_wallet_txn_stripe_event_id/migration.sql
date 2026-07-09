-- AlterTable
ALTER TABLE "WalletTransaction" ADD COLUMN     "stripeEventId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "WalletTransaction_stripeEventId_key" ON "WalletTransaction"("stripeEventId");
