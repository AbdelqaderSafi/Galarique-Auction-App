-- Remove reservePrice entirely (startingPrice is the min-to-sell).
ALTER TABLE "Auction" DROP COLUMN "reservePrice";
