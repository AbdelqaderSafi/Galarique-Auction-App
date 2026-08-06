-- Tiered minimum bid increment.
--
-- The increment is no longer a per-auction value: it follows the current price
-- through a fixed tier table (<25 -> 1, 25-100 -> 2, 100-1000 -> 10, >=1000 -> 50),
-- with tier boundaries closed at the bottom (exactly 100 -> 10, exactly 1000 -> 50).
--
-- No schema change: "Auction"."minBidIncrement" stays as a read-side copy that the
-- backend rewrites after every price change. This migration only realigns rows that
-- were created under the earlier fixed-value rules (50, then 10) so that every
-- auction — live ones included — is consistent with the tier table from now on.
--
-- The tier is derived from "currentPrice", which stays 0 until the first bid; for an
-- auction with no bids yet the opening tier comes from "startingPrice" instead.
UPDATE "Auction"
SET "minBidIncrement" = CASE
  WHEN COALESCE(NULLIF("currentPrice", 0), "startingPrice") >= 1000 THEN 50
  WHEN COALESCE(NULLIF("currentPrice", 0), "startingPrice") >= 100 THEN 10
  WHEN COALESCE(NULLIF("currentPrice", 0), "startingPrice") >= 25 THEN 2
  ELSE 1
END;
