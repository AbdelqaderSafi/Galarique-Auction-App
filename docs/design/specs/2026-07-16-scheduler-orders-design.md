# Scheduler + Orders — Design Spec

**Date:** 2026-07-16
**Modules:** `scheduler` + `orders` (built together)
**Status:** Approved design — ready for implementation plan

---

## 1. Purpose & Scope

Nothing currently closes an auction: one past its `endTime` stays `status=LIVE` forever (only
`bids` guards it, by rejecting bids once the time passes). This spec closes that gap and settles
the sale end-to-end: close the auction, pick the winner, take the money, and hand it to the seller.

### In scope
- `scheduler` module: `@nestjs/schedule` cron (every minute) running three idempotent catch-up jobs.
- `orders` module: the `Order` lifecycle — creation at close, payment, default, second-chance.
- Payment: auto-deduct at close, explicit pay endpoint, scheduler auto-retry.
- Deposit settlement: applied to the price on payment, forfeited on default.
- Emails for the close/payment events.
- `POST /scheduler/run` (ADMIN) — run one tick on demand.

### Out of scope / explicitly removed
- **Escrow is removed from the product** (decided 2026-07-16). Payment credits the seller's wallet
  immediately and the order is `COMPLETED`. There is no platform holding period, no "confirm
  receipt", and no 14-day auto-release.
- **The `disputes` module is dropped from the roadmap** — with no held funds there is nothing to
  arbitrate. Consequence accepted knowingly: **the buyer has no in-app protection.** If a seller
  takes payment and never hands over the item, the app offers no refund path. Accepted as a
  scope-reduction for a graduation project.
- `favorites`/`follows` remain the only planned modules after this one.

---

## 2. Decisions (agreed — do not re-litigate)

| Decision | Value |
|---|---|
| Scheduling | `@nestjs/schedule`, `@Cron` **every minute**, in-process |
| Job style | **Catch-up scans** (`WHERE ... <= now()`), never per-auction timers |
| $50 deposit at close | **Applied to the price**: `amountDue = max(0, amount − 50)` |
| Winner payment | **Auto-deduct at close** if funded; else 72h window |
| Payment during the 72h | **Both** an explicit `POST /orders/:id/pay` **and** scheduler auto-retry |
| Winner defaults (72h) | **$50 FORFEITED to the platform**; order `DEFAULTED` |
| Second chance | **2nd-highest bidder only**, then `UNSOLD` (no deeper cascade) |
| Second-chance price | **The 2nd bidder's own highest bid** (not the winner's price) |
| Second-chance payment | **Explicit pay only — never auto-charged** (the offer is optional) |
| Second-chance deposit | **None** (theirs was released when outbid) → `depositApplied = 0` |
| Price < deposit | Deposit covers it; **excess refunded to the buyer** |
| Money terminal state | Seller's wallet credited → order `COMPLETED` (**no escrow**) |
| Manual tick | `POST /scheduler/run` (ADMIN) |

---

## 3. Architecture

Two modules with a hard boundary:

- **`scheduler`** — timing only, **zero business logic**. A `@Cron` method per job that calls into
  `OrdersService`. Also exposes `POST /scheduler/run` (ADMIN) which invokes the same methods.
  Rationale: the business logic stays callable (and testable) without waiting for cron, and every
  timing rule lives in one file.
- **`orders`** — owns the `Order` lifecycle and all money movement for a sale.

**Catch-up principle:** every job is a "scan for due work" query, so a missed tick (deploy, restart,
downtime) is self-healing — the next tick picks the work up. Nothing is lost, nothing needs a
durable timer.

**Concurrency:** every state transition is a conditional `updateMany` (e.g. `where { id, status: LIVE }`)
with an affected-row-count check, inside a transaction that row-locks the target. Two scheduler
instances cannot double-process the same auction or order.

**Auction lifecycle (final):**
```
LIVE ──(time up, has bids)──> ENDED ──(paid)──> SOLD          [Object → SOLD]
  │                              └──(all defaulted)──> UNSOLD  [Object → AVAILABLE]
  └──(time up, no bids)────────────────────────────> UNSOLD    [Object → AVAILABLE]
```

---

## 4. Scheduler Jobs (every minute)

### Job A — close due auctions
Query: `Auction WHERE status = LIVE AND endTime <= now()`.
Per auction, in a transaction with the auction row locked:
1. Conditional guard: re-check `status = LIVE`; skip if another instance won the race.
2. **No bids** (`currentWinnerId IS NULL`) → auction `UNSOLD`, Object `AVAILABLE`,
   `sendAuctionUnsold` to the seller. Done.
3. **Has a winner** → auction `ENDED`, create the `Order`:
   - `buyerId = currentWinnerId`, `sellerId = object.ownerId`
   - `amount = currentPrice`, `depositApplied = 50`, `amountDue = max(0, currentPrice − 50)`
   - `offerRank = 1`, `status = AWAITING_PAYMENT`, `paymentDeadline = now + 72h`
4. Attempt `payOrder()` immediately:
   - success → auction `SOLD`, Object `SOLD`, `sendOrderPaid` (buyer) + `sendItemSold` (seller)
   - insufficient balance → order stays `AWAITING_PAYMENT`, `sendPaymentRequired` (buyer)

### Job B — expire payment deadlines
Query: `Order WHERE status = AWAITING_PAYMENT AND paymentDeadline <= now()`.
Per order, in a transaction with the order row locked (conditional guard first):

- **`offerRank = 1`** (the winner defaulted):
  1. Forfeit the deposit: buyer `lockedBalance −50`, `AuctionDeposit → FORFEITED`,
     `WalletTransaction { type: DEPOSIT_FORFEIT, amount: 50, refId: auctionId }`.
     (The platform keeps it; there is no platform wallet row — the funds simply leave the user.)
  2. Order → `DEFAULTED`.
  3. Find the **second-highest bidder** = the highest `Bid` whose `bidderId != buyerId`
     (a bidder may hold several bids; take their best one).
     - Found → create the second-chance `Order`: `buyerId = that bidder`, `amount = that bid's amount`,
       `depositApplied = 0`, `amountDue = amount`, `offerRank = 2`, `status = AWAITING_PAYMENT`,
       `paymentDeadline = now + 72h`; `sendSecondChance` to them.
     - None → auction `UNSOLD`, Object `AVAILABLE`, `sendAuctionUnsold` to the seller.
- **`offerRank = 2`** (the optional offer lapsed):
  - Order → `CANCELLED` (not `DEFAULTED` — they broke no commitment, and there is no deposit to
    forfeit), auction `UNSOLD`, Object `AVAILABLE`, `sendAuctionUnsold` to the seller.

### Job C — retry winner payments
Query: `Order WHERE status = AWAITING_PAYMENT AND offerRank = 1 AND paymentDeadline > now()`.
Per order → attempt `payOrder()`; an insufficient balance is not an error, just skip.
**`offerRank = 2` is deliberately excluded** — the second-chance offer is optional and must never be
auto-charged.

---

## 5. `payOrder()` — the single payment path

One method shared by all three callers (auto-deduct at close, the pay endpoint, the retry job), so
the money rules exist in exactly one place. Runs in one transaction with the `Order` row locked.

**Guards:** status is `AWAITING_PAYMENT` · `paymentDeadline > now` · (endpoint only) caller is the buyer.

**Money movement:**
- **`offerRank = 1`** (has $50 locked):
  - `amountDue = max(0, amount − 50)`
  - Atomic guarded debit: `wallet.updateMany where { userId: buyerId, balance: { gte: amountDue } }`
    → `balance −= amountDue`, `lockedBalance −= 50`. Zero rows affected → insufficient balance.
  - If `amount < 50` → also `balance += (50 − amount)` and log `WalletTransaction { type: REFUND }`
    for the excess.
  - `AuctionDeposit → APPLIED`.
- **`offerRank = 2`** (no deposit):
  - `amountDue = amount`; atomic guarded debit `balance >= amount` → `balance −= amount`.

**Then:**
- Buyer ledger: `WalletTransaction { type: PURCHASE, amount, refId: orderId }` (the full price;
  the note records that $50 came from the deposit).
- Seller: get-or-create wallet → `balance += amount`;
  `WalletTransaction { type: SALE, amount, refId: orderId }`.
- Order → `COMPLETED`, `paidAt = now`, `completedAt = now`.
- Auction → `SOLD`, Object → `SOLD`.

**Worked example** — final price $200, winner holds $50 locked + $160 balance:

| | before | after |
|---|---|---|
| buyer `balance` | 160 | **10** (−150) |
| buyer `lockedBalance` | 50 | **0** (deposit applied) |
| seller `balance` | 0 | **200** |

---

## 6. Endpoints

| Method | Path | Access | Purpose |
|---|---|---|---|
| `POST` | `/orders/:id/pay` | 🔒 buyer | "Pay now" — calls `payOrder()` |
| `GET` | `/orders/mine` | 🔒 | My orders as buyer (newest first, `?page&limit`) |
| `GET` | `/orders/sales` | 🔒 | My sales as seller (newest first, `?page&limit`) |
| `GET` | `/orders/:id` | 🔒 buyer or seller | Detail + **the counterpart's email** (for `mailto:` contact) |
| `POST` | `/scheduler/run` | 🔒 ADMIN | Run one tick of all three jobs; returns counts |

`POST /orders/:id/pay` errors: `403` not your order · `404` unknown · `400` wrong status / deadline
passed / insufficient balance (with needed/available, matching the `bids` deposit message style).

No "decline second chance" endpoint — ignoring the offer is declining (it lapses after 72h). YAGNI.

---

## 7. Emails

Fire-and-forget after commit (a mail failure must never fail the transaction), matching the
`bids` outbid pattern. New `MailService` methods:

- `sendPaymentRequired` (buyer) — you won; pay `amountDue` within 72h.
- `sendOrderPaid` (buyer) — you won and payment is complete.
- `sendItemSold` (seller) — sold for $X; includes the buyer's email for contact.
- `sendSecondChance` (2nd bidder) — the winner didn't pay; it's yours at your bid of $X within 72h.
- `sendAuctionUnsold` (seller) — no bids, or nobody paid.

A pre-deadline payment reminder is deliberately **not** built (YAGNI).

---

## 8. Schema Changes

**Additive only** — safe via `prisma migrate diff` → `migrate deploy` (never `migrate dev`, per the
known `20260706160744_category_enum` drift gotcha; a reset would wipe the mobile team's data).

Dropping escrow left two honesty gaps in the ledger:

1. **`WalletTxnType`** has no purchase/sale type. The old design used `ESCROW_IN`/`ESCROW_RELEASE`;
   with no escrow those names would lie. **Add `PURCHASE`** (buyer debit) and **`SALE`** (seller credit).
2. **`DepositStatus`** has no "applied" state. When the deposit goes toward the price, both
   `RELEASED` (returned to them) and `FORFEITED` (lost) are false. **Add `APPLIED`**.

**Dead but retained** (documented as unused; removing them triggers the drift/reset gotcha for zero
gain): `Dispute`, `DisputeStatus`, `OrderStatus.PAID_IN_ESCROW` / `DISPUTED` / `REFUNDED`,
`Order.autoReleaseAt`, `WalletTxnType.ESCROW_IN` / `ESCROW_RELEASE`.

`Order.offerRank` stays meaningful (1 = winner, 2 = second chance). `Order.depositApplied` stays
(50 for rank 1, 0 for rank 2).

---

## 9. Edge Cases

- **Race: Job B (expire) vs. the pay endpoint at the same instant** — both lock the `Order` row, so
  they serialize; the loser re-reads, sees the changed status, and aborts.
- **Seller has no wallet** → get-or-create on credit.
- **Winner withdrew their balance after bidding** — the $50 is locked and unwithdrawable, but the
  rest is not → auto-pay fails → the 72h window applies.
- **Second-chance bidder short on funds** — their deposit was released when outbid, so they may have
  less than their bid; they must top up and pay explicitly.
- **Single bid, bidder defaults** → no second-highest → `UNSOLD`.
- **Final price below $50** → `amountDue = 0`, seller credited the full price, excess deposit
  refunded to the buyer.
- **`endTime IS NULL` on a LIVE auction** (shouldn't occur; `approve` always sets it) — a `lte`
  filter never matches NULL, so such rows are skipped rather than crashing.

---

## 10. Testing (live HTTP, per project convention)

No jest for feature modules — live endpoint testing via the `test-endpoints` skill, seeding directly
into the Neon **dev** branch with raw `pg` (as `bids` did).

**Beating the clock:** seed `endTime` and `paymentDeadline` **in the past** so work is immediately
due, then drive ticks with `POST /scheduler/run` instead of waiting for cron.

Scenarios:
1. Close with no bids → `UNSOLD`, Object `AVAILABLE`.
2. Close with a funded winner → auto-paid → Order `COMPLETED`, auction `SOLD`, Object `SOLD`;
   buyer `−amountDue` and `lockedBalance = 0`; seller `+amount`.
3. Close with an unfunded winner → `AWAITING_PAYMENT` + 72h → top up → `POST /orders/:id/pay` → `COMPLETED`.
4. Auto-retry: unfunded winner tops up → next tick pays automatically.
5. Deadline expiry (rank 1) → deposit `FORFEITED`, order `DEFAULTED`, second-chance order created.
6. Second-chance bidder pays → `COMPLETED` at **their** bid price; auction `SOLD`.
7. Second-chance ignored → order `CANCELLED`, auction `UNSOLD`, Object `AVAILABLE`.
8. **Second-chance is never auto-charged** — a funded rank-2 order survives a tick untouched.
9. Final price $20 (< deposit) → `amountDue = 0`, buyer refunded $30, seller `+$20`.
10. Guards: pay someone else's order → `403`; pay twice → `400`; pay past deadline → `400`;
    no token → `401`; `POST /scheduler/run` as non-admin → `403`.
11. Reads: `/orders/mine`, `/orders/sales`, `/orders/:id` (buyer and seller OK, third party rejected).
