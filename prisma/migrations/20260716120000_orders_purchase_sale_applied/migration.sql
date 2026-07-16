-- AlterEnum
ALTER TYPE "DepositStatus" ADD VALUE 'APPLIED';

-- AlterEnum
ALTER TYPE "WalletTxnType" ADD VALUE 'PURCHASE';
ALTER TYPE "WalletTxnType" ADD VALUE 'SALE';

-- CreateIndex
CREATE INDEX "Order_status_paymentDeadline_idx" ON "Order"("status", "paymentDeadline");
