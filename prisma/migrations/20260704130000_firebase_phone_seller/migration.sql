-- DropForeignKey
ALTER TABLE "PhoneVerification" DROP CONSTRAINT "PhoneVerification_userId_fkey";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isPhoneVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "phone" TEXT;

-- DropTable
DROP TABLE "PhoneVerification";

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");
