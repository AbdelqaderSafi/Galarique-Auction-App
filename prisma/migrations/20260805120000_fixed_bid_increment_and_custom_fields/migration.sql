-- AlterTable
ALTER TABLE "Auction" ALTER COLUMN "minBidIncrement" SET DEFAULT 10;

-- AlterTable
ALTER TABLE "Object" ADD COLUMN     "customFields" JSONB NOT NULL DEFAULT '[]';
