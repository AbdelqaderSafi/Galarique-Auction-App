# Tiered minimum bid increment

**Date:** 2026-08-06
**Status:** approved, implemented
**Supersedes:** the "fixed at $10" rule from `2026-08-05-fixed-bid-increment-and-custom-fields-design.md` (the "seller never sets it" part of that decision stands unchanged)

## Problem

`minBidIncrement` was a single number per auction — first seller-chosen, then fixed at $10. A flat increment fits badly at both ends of the catalogue: $10 is a large jump on a $20 collectible and a rounding error on a $5,000 painting.

## Decision

The increment follows the **current price** through a fixed table:

| نطاق السعر الحالي ($) | الحد الأدنى للزيادة ($) |
|---|---|
| أقل من 25 | 1 |
| 25 – 100 | 2 |
| 100 – 1,000 | 10 |
| 1,000 فأكثر | 50 |

**Boundaries are closed at the bottom:** exactly 100 falls in the $10 tier, exactly 1000 in the $50 tier. This is the usual convention for auction increment tables and keeps every boundary consistent (the table's literal "أكثر من 1,000" would have made 1000 behave differently from 25 and 100).

The seller still never sets the increment — that part of the 2026-08-05 decision is unchanged, and the field stays absent from the `POST /auctions` and `PATCH /auctions/:id` schemas.

## Source of truth

`minIncrementFor(price)` in `src/modules/auctions/util/bid-increment.util.ts` is the only authority. `Auction.minBidIncrement` is a **read-side copy** — never an input to a decision.

`BidsService.place()` computes the floor from the function, not the column:

```ts
floor = isFirstBid ? startingPrice : currentPrice.add(minIncrementFor(currentPrice))
```

so a column that has drifted (stale seed data, a row missed by a backfill) cannot corrupt a bid. The tier used is that of the price being raised **from**, not of the incoming bid.

Three places write the column:

| Place | Value |
|---|---|
| `AuctionsService.create()` | `minIncrementFor(startingPrice)` — the tier the auction opens in |
| `AuctionsService.update()` | re-seeded **only if** `startingPrice` changed (editing is allowed pre-launch only, so `currentPrice` is still 0) |
| `BidsService.place()` | `minIncrementFor(newAmount)`, inside the same transaction and row lock as the bid |

`incrementBasis(currentPrice, startingPrice)` exists because `currentPrice` stays 0 until the first bid; without it an unbid $5,000 auction would display the $1 tier.

### Why the helper lives under `auctions`

`bids` already imports `PUBLIC_STATUSES` from `auctions.service`, so the dependency runs bids → auctions. Putting the table under `bids` and importing it from `auctions.create()` would close that into a cycle. A neutral `src/common/` for one file was not worth the structure.

## API contract

`minBidIncrement` keeps its name, its place in every auction response, and its meaning ("the increment that applies right now"), so no read path needed a mapping change and no existing client breaks.

What *did* change is that the value is no longer constant for the life of an auction. A client that read it once and cached it will compute the wrong minimum after the price crosses 25, 100, or 1000. Two additive fields close that gap:

- the `bid` SSE event now carries `minBidIncrement`
- the `POST /auctions/:id/bids` response now carries `minBidIncrement`

Both are additions; older clients ignoring them are unaffected — but the mobile app must re-read the value rather than caching it.

## Migration

`20260806090000_tiered_bid_increment` is **data-only** — no schema change. A single `UPDATE` realigns every existing row to the table, deriving the tier from `currentPrice`, falling back to `startingPrice` when there are no bids yet.

Applied to Neon after previewing the impact: **49 auctions, 35 changed, 3 of them LIVE — and none of those 3 had any bids.** The concern that motivated the earlier "new auctions only" decision (not shifting the rules under bidders already committed) did not arise, so realigning everything was safe and leaves one rule for the whole system instead of a permanent old/new split.

The `@default(10)` on the column stays as an inert fallback: every write path sets the value explicitly, and dropping the default would risk raw-SQL insert paths in the seed scripts for no gain.

## Testing

- `bid-increment.util.spec.ts` — every tier boundary exactly (0 · 24.99 · **25** · 99.99 · **100** · 999.99 · **1000** · 5000), Decimal/string inputs, negative-price fallback, and the `incrementBasis` pre-first-bid case.
- `bids.service.spec.ts` — the floor is derived from the tier **while the stored column deliberately says something else**; the tier of the from-price is used, not the new price; crossing a boundary rewrites the column and the value reaches both the response and the SSE event.
- `auctions.service.spec.ts` — create seeds from the `startingPrice` tier and ignores any client-sent value; `PATCH` re-seeds only when `startingPrice` changes.
- Integration — a live bid at 150 keeps the $10 tier, and 155 is rejected.
- System — six starting prices map to their tiers over real HTTP; `PATCH` moves an auction between tiers; `test-bids.mjs` asserts the floor is 210 (tier) on a row seeded with a stale increment of 50; `test-realtime.mjs` asserts the SSE event carries the tier.
