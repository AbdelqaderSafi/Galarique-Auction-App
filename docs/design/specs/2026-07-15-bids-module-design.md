# Bids Module — Design Spec

**Date:** 2026-07-15
**Module:** `bids` (next in roadmap, precedes `orders`)
**Status:** Approved design — ready for implementation plan

---

## 1. Purpose & Scope

The `bids` module lets any authenticated user place bids on a **LIVE** auction. Placing a
winning bid holds a flat **$50 deposit** on the bidder, enforces the price floor, updates the
auction's `currentPrice`/`currentWinner`, **releases the previous highest bidder's deposit**,
applies anti-snipe time extension, and notifies the previous highest bidder by email.

### Deposit model (decided 2026-07-15 — supersedes the older docs/PROJECT-CONTEXT.md model)
At any moment, **only the current highest bidder** holds a $50 deposit for an auction:
- Taking the lead → hold $50 (`balance → lockedBalance`).
- Being outbid → the deposit is **released immediately** (`lockedBalance → balance`).

So at close, only the winner still holds a deposit; there are no held "losers" to release later.
This **diverges from the current docs/PROJECT-CONTEXT.md** ("held on first bid, released at close, forfeited +
second-chance cascade"). The winner/second-chance flow is redefined below and belongs to
`orders`/`scheduler` — docs/PROJECT-CONTEXT.md's Bidding/Winning/Deposit sections must be updated when those
modules are built.

### In scope
- `POST /auctions/:id/bids` — place a bid (the core: transaction + row lock + deposit + anti-snipe).
- `GET /auctions/:id/bids` — public bid history for an auction.
- `GET /bids/mine` — the current user's bids across all auctions.
- Holding the current bidder's $50 deposit **and releasing the displaced bidder's** deposit,
  via new `WalletService` helpers.
- Outbid email to the previous highest bidder.

### Out of scope (belongs to later modules)
- **Determining the final winner, deducting payment, and creating the `Order`** — at auction
  close → `orders` + `scheduler`. The intended close flow (for context, not built here):
  1. Time ends → highest bidder is the winner (their $50 deposit still held).
  2. Deduct the amount from the winner's wallet. If balance is insufficient → give **72 hours**
     to top up and pay.
  3. Unpaid within 72h → offer the auction to the **second-highest bidder** (**optional** — "if
     they want it", **no held deposit / no forfeiture**), who also gets 72 hours.
  4. Still unpaid → the auction is cancelled / `UNSOLD`.
- **Closing the auction** (`LIVE → ENDED`) — the `scheduler`. However, `bids` still **rejects**
  a bid when `endTime` has passed even if the status is still `LIVE` (scheduler hasn't run yet).

---

## 2. Module Structure

Standalone module following existing conventions (match `wallet` / `auctions`):

```
src/modules/bids/
  dto/bids.dto.ts                    # PlaceBidDto (class + @ApiProperty) + response types
  util/bids.validation.schema.ts     # Zod: { amount: positive, ≤ 2 decimal places }
  bids.service.ts
  bids.controller.ts
  bids.module.ts                     # imports WalletModule
src/swagger/bids.swagger.ts          # applyDecorators(...) + SwaggerXTag
```

- Register `BidsModule` in `src/app.module.ts` imports.
- `BidsModule` imports `WalletModule` (already exports `WalletService`).
- `MailService` is used for the outbid email (add a `sendOutbid` method).
- Guards are global (`AuthGuard` + `RolesGuard`); routes are protected by default. Public
  routes use `@IsPublic(true)`.

---

## 3. Endpoints

| Method | Path | Access | Purpose |
|---|---|---|---|
| `POST` | `/auctions/:id/bids` | 🔒 any authenticated user | Place a bid (core logic) |
| `GET`  | `/auctions/:id/bids` | 🌐 public (`@IsPublic`) | Auction bid history (highest first, paginated) |
| `GET`  | `/bids/mine` | 🔒 | The user's own bids across all auctions (paginated) |

Guest (unauthenticated) cannot bid — protected by the global auth guard by default.

---

## 4. `POST /auctions/:id/bids` — Core Logic

All steps run inside one **interactive `$transaction`**.

### 4.1 Lock & read
`SELECT ... FOR UPDATE` on the auction row via `tx.$queryRaw`, then read it with Prisma inside
the same transaction. Concurrent bids on the same auction serialize on this row lock — a second
bid waits and then sees the updated price.

### 4.2 Validations (in order)
1. Auction exists → else `404`.
2. `status === LIVE` **and** `endTime > now` → else `400` ("Auction is not live").
3. Bidder is **not** the object owner → else `403` (shill bidding).
4. Bidder is **not** the current `currentWinnerId` → else `400` ("You're already the highest bidder").
5. **Price floor:**
   - First bid (`currentPrice === 0` and no `currentWinnerId`): `amount ≥ startingPrice`.
   - Otherwise: `amount ≥ currentPrice + minBidIncrement`.
   - Else `400` with the exact required amount (e.g. "Minimum bid is $250.00").

### 4.3 Hold the bidder's deposit
Call `WalletService.holdBidDeposit(tx, userId, auctionId)` — **idempotent**:
- Get-or-create the wallet.
- Read the `AuctionDeposit` for `(auctionId, userId)` (unique).
- If it exists and is already `HELD` → no-op (defensive; a challenger's row is never HELD because
  it was released when they were outbid, and the current winner is blocked from re-bidding).
- Otherwise (no row, or `RELEASED`) → hold:
  - If `balance < 50` → `400` with the shortfall (`needed: $50.00`, `available: $X.XX`).
  - Else: `balance -= 50`, `lockedBalance += 50`, upsert the `AuctionDeposit` to `HELD`
    (reuse the existing row — the `@@unique([auctionId, userId])` means one row per bidder,
    toggled `RELEASED ↔ HELD`), create `WalletTransaction { type: DEPOSIT_HOLD, amount: 50, refId: auctionId }`.

### 4.4 Record bid, update auction & release the displaced bidder
- Capture `previousWinnerId` (for the release + email) before updating.
- `Bid.create({ auctionId, bidderId, amount })`.
- `Auction.update({ currentPrice: amount, currentWinnerId: bidderId })`.
- **If `previousWinnerId` exists** → `WalletService.releaseBidDeposit(tx, previousWinnerId, auctionId)`:
  moves `lockedBalance → balance` ($50), sets `AuctionDeposit` `HELD → RELEASED`, creates
  `WalletTransaction { type: DEPOSIT_RELEASE, amount: 50, refId: auctionId }`.

All deposit logic lives in `WalletService` (each helper takes the `tx` client) so wallet tables are
only touched by the wallet module; `bids` never manipulates `wallet`/`walletTransaction` directly.

### 4.5 Anti-snipe
If `endTime - now ≤ antiSnipeSeconds` → `endTime += extendBySeconds` (in the same auction update).
Return the (possibly extended) `endTime` in the response.

### 4.6 After the transaction commits (outside `$transaction`)
If `previousWinnerId` exists and differs from the bidder → `mail.sendOutbid(...)`, fire-and-forget
(a mail failure must not fail the request), matching the `auctions` module pattern.

### 4.7 Response — `PlaceBidResponse`
```
{ bidId, amount, currentPrice, endTime, isHighest: true, depositHeld: boolean }
```
`depositHeld` tells the mobile app whether a $50 deposit was newly held on this call (true unless
the bidder already had a HELD deposit — a defensive edge case); `endTime` reflects any anti-snipe
extension.

---

## 5. Read Endpoints

### 5.1 `GET /auctions/:id/bids` (public)
- Verify the auction exists and its status is in the public set (reuse `PUBLIC_STATUSES` from
  `auctions`) → else `404`.
- Return bids ordered by `amount desc` (highest first), including `bidder: { fullName }`, paginated
  (`?page&limit`).
- Item shape: `{ id, amount, bidderName, createdAt }` plus `{ page, limit, total }`.
- **Bidder name is shown in full** (no anonymization).

### 5.2 `GET /bids/mine` (🔒)
- The user's bids across all auctions, newest first, paginated.
- Each item carries brief auction info:
  `{ auctionId, title, mainImage, status, currentPrice, myAmount, isWinning, createdAt }`.
- `isWinning = auction.currentWinnerId === userId`.

---

## 6. DTOs & Validation

**`dto/bids.dto.ts`:**
- `PlaceBidDto` — class with `@ApiProperty`: `amount: number`.
- Exported response `type`s: `BidResponse`, `PlaceBidResponse`, `AuctionBidsResponse`, `MyBidsResponse`.

**`util/bids.validation.schema.ts`** (matching `wallet.validation.schema.ts`):
```ts
placeBidSchema = z.object({
  amount: z.number().positive() // > 0, at most 2 decimal places
})
```
Applied with `ZodValidationPipe` on the `@Body()`.

---

## 7. Concurrency

Interactive `$transaction` + `SELECT ... FOR UPDATE` on the auction row. This serializes
concurrent bids on the same auction: the second bidder waits on the lock, then re-evaluates the
price floor against the updated `currentPrice` and is rejected if now too low. Neon's pooled
connection keeps the session pinned for the duration of an interactive transaction, so the lock
holds correctly.

---

## 8. Schema & Migrations

- `Bid` and `AuctionDeposit` models **already exist** in `schema.prisma`, complete with indexes
  (`Bid @@index([auctionId, amount])`, `@@index([bidderId])`) and `AuctionDeposit @@unique([auctionId, userId])`.
- Auction fields updated by bids (`currentPrice`, `currentWinnerId`, `endTime`) already exist.
- **No new migration is required** — this avoids the known migration-drift issue on
  `20260706160744_category_enum`.

---

## 9. Testing (via the `test-endpoints` skill after build)

1. **Happy path:** first bid ≥ `startingPrice` → succeeds; $50 deposit held (verify via `/wallet`:
   `balance −50`, `lockedBalance +50`, and a `DEPOSIT_HOLD` transaction).
2. **Outbid + release:** user B bids ≥ `currentPrice + increment` → succeeds; B's $50 is held **and
   user A's $50 is released** (A's wallet: `lockedBalance −50`, `balance +50`, `DEPOSIT_RELEASE` txn;
   A's `AuctionDeposit` → RELEASED); an **outbid email** is sent to A (confirm in logs).
3. **Retake the lead:** user A outbids B again → A's row toggles `RELEASED → HELD` (no duplicate
   `AuctionDeposit` row), B's is released. Only the current winner ever holds a deposit.
4. **Rejections:** below the floor / current winner re-bidding / owner bidding / balance < $50
   (needed/available message) / auction not LIVE / guest without a token (`401`).
5. **Reads:** `GET /auctions/:id/bids` (public) and `GET /bids/mine` (protected).
6. **(Optional) Concurrency:** two near-simultaneous bids → one wins, the other is rejected against
   the new price.

---

## 10. Wallet & Mail Additions

- **`WalletService.holdBidDeposit(tx, userId, auctionId)`** — new exported helper; idempotent
  atomic $50 hold inside the caller's transaction (upsert `AuctionDeposit` → HELD, `balance →
  lockedBalance`, `DEPOSIT_HOLD` txn); throws `400` on insufficient balance (with needed/available).
- **`WalletService.releaseBidDeposit(tx, userId, auctionId)`** — new exported helper; releases a
  HELD deposit (`lockedBalance → balance`, `AuctionDeposit` → RELEASED, `DEPOSIT_RELEASE` txn);
  no-op if the deposit is not currently HELD. Used here on outbid; reusable later by orders/scheduler.
- **`MailService.sendOutbid(to, fullName, auctionTitle, newPrice)`** — new method matching the
  existing email patterns (HTML + text, resilient when `BREVO_API_KEY` is missing).
