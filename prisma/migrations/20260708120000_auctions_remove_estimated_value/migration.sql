-- Remove the private estimatedValue column from Auction (dropped from the domain model).
ALTER TABLE "Auction" DROP COLUMN "estimatedValue";
