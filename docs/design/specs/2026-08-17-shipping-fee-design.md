# Shipping fee — $20 flat, paid by the buyer (2026-08-17)

> Supersedes the "Shipping is OUT of scope" line in `docs/PROJECT-CONTEXT.md` and
> [2026-06-21-backend-clarifications-design.md](2026-06-21-backend-clarifications-design.md) §Scope —
> **only** for the money side. No carrier, no tracking, no address, no shipment states.

## Decision

Every order charges the buyer a flat **$20 shipping fee** on top of the winning price. The fee is
**credited to the seller** (the seller is the one who ships), so it is not platform revenue and needs
no platform wallet and no new `WalletTxnType`.

The fee is a **hardcoded constant**, not a column. Chosen over a `Order.shippingFee` snapshot column
deliberately: no migration, no schema change, faster to land. Accepted cost — an order row cannot
tell you how much of its `amountDue` was shipping, so if the amount ever changes, historical orders
become unexplainable. See [Alternatives rejected](#alternatives-rejected).

## Scope

**Changes:** `orders` module only (`orders.service.ts`, `settlement.service.ts`) plus tests and docs.

**Does NOT change:** the `auctions` module, the Prisma schema, any migration, the `$50` deposit, the
bid-time balance check, the 72-hour payment window, the second-chance cascade rules, or any API
request shape. The buyer sees the fee only once an order exists — it is not surfaced on the auction
browse/detail endpoints (explicit product decision).

## Money model

```
SHIPPING_FEE = 20
totalDue     = amount + SHIPPING_FEE
amountDue    = totalDue > depositApplied ? totalDue − depositApplied : 0
excess       = depositApplied > totalDue ? depositApplied − totalDue : 0
netPaid      = amountDue + depositApplied − excess      // what actually left the buyer
seller credit = netPaid
```

`netPaid` — not `amount + SHIPPING_FEE` — is the seller credit. This is the load-bearing part of the
design; see [Legacy in-flight orders](#legacy-in-flight-orders).

### Worked examples

| Case | `amount` | `depositApplied` | `amountDue` (debited from wallet) | Excess refunded | Seller credited |
|---|---|---|---|---|---|
| Normal win | 500.00 | 50.00 | 470.00 | — | 520.00 |
| Small win | 60.00 | 50.00 | 30.00 | — | 80.00 |
| Deposit covers most | 40.00 | 50.00 | 10.00 | — | 60.00 |
| Deposit covers exactly | 30.00 | 50.00 | 0.00 | — | 50.00 |
| Deposit overshoots | 25.00 | 50.00 | 0.00 | 5.00 | 45.00 |
| Second chance (rank 2) | 200.00 | 0.00 | 220.00 | — | 220.00 |
| **Legacy row (pre-fee)** | 500.00 | 50.00 | 450.00 | — | **500.00** |

The last row is the point of deriving from `netPaid`: a row created before this change still settles
at its original, fee-free numbers with no flag on the row and no `createdAt` cutoff.

## Code changes

### `src/modules/orders/orders.service.ts`

Export the constant next to `DEPOSIT_AMOUNT`:

```ts
export const SHIPPING_FEE = new Prisma.Decimal(20);
```

In `payOrder()`:

1. The guarded atomic debit stays exactly as-is — it reads `order.amountDue`, which was computed and
   stored at order creation.
2. Hoist `excess` out of the refund `if` so it can feed `netPaid` (default `new Prisma.Decimal(0)`).
3. Compare against `totalDue`, not `amount`:
   `if (usesDeposit && order.depositApplied.greaterThan(order.amount.plus(SHIPPING_FEE)))`.
   Refund note becomes `'Deposit exceeded the total due'` — "final price" no longer describes what
   the deposit is being compared against.
4. Compute `netPaid = order.amountDue.plus(order.depositApplied).minus(excess)`.
5. Buyer `PURCHASE` transaction: `amount: netPaid` (was `order.amount`) — the buyer's ledger must
   match what actually left their wallet.
6. Seller credit **and** the `SALE` transaction: `netPaid` (was `order.amount`). The `PURCHASE` and
   `SALE` note strings stay unchanged — a legacy row settling after the deploy genuinely has no
   shipping in it, so an "incl. shipping" note would be false for that row.

### `src/modules/orders/settlement.service.ts`

Rank-1 order creation (`closeDueAuctions`, currently line ~113):

```ts
const totalDue = amount.plus(SHIPPING_FEE);
const amountDue = totalDue.greaterThan(DEPOSIT_AMOUNT)
  ? totalDue.minus(DEPOSIT_AMOUNT)
  : new Prisma.Decimal(0);
```

Rank-2 second-chance order creation (`expirePaymentDeadlines`, currently line ~334):
`amountDue: second.amount.plus(SHIPPING_FEE)` — no deposit exists, so the fee is added in full.

The `won` SSE payload and `sendPaymentRequired` both read the new `amountDue`, so they carry the
fee-inclusive figure automatically.

## Legacy in-flight orders

Orders already sitting in `AWAITING_PAYMENT` when this deploys have a `amountDue` computed **without**
the fee. Deriving the seller credit from `netPaid` handles them correctly — no money is invented.

**One residual gap:** the excess-refund branch reads the constant, so it cannot tell a legacy row from
a new one. For a legacy rank-1 row with `amount = A`:

- correct refund is `max(0, 50 − A)` — nonzero whenever `A < 50`
- the new code refunds `max(0, 30 − A)` — nonzero only when `A < 30`

So the shortfall is `20` for `A < 30`, and `50 − A` for `30 ≤ A < 50`. Because `netPaid` is derived
from the same `excess`, the seller is over-credited by exactly the shortfall — the ledger stays
balanced, but both the buyer's refund and the seller's credit are wrong by up to $20.

Pre-deploy check — if this returns `0`, the gap cannot occur:

```sql
SELECT count(*) FROM "Order"
WHERE status = 'AWAITING_PAYMENT' AND "offerRank" = 1 AND amount < 50;
```

If it returns non-zero, settle or cancel those orders before deploying rather than adding a
`createdAt` cutoff to the code. Rank-2 rows are unaffected (`depositApplied = 0`, so the refund
branch never runs).

## Emails

- `sendPaymentRequired` prints `amountDue` → fee-inclusive with no template change.
- `sendSecondChance` prints the bid amount, not the total. Left as-is.
- `sendOrderPaid` prints `order.amount` (item price, excluding shipping). Left as-is by decision; the
  fee is an order-level detail, not an email-level one.

## Tests to update

| File | Why |
|---|---|
| `src/modules/orders/orders.service.spec.ts` | The excess-refund case (`amount` 30, expects a $20 refund) now refunds $0. Needs post-fee fixtures, plus new assertions that the seller is credited `netPaid` and that a legacy-shaped row still credits `amount`. |
| `src/modules/orders/settlement.service.spec.ts` | `amountDue` assertions on both order-creation paths. |
| `test/integration/auction-lifecycle.integration-spec.ts` | Asserts wallet balances after the winner pays. |
| `scripts/test-orders.mjs` | System-test expectations for `amountDue`. |

Add one unit test per row of the worked-examples table, including the legacy row — that table is the
acceptance criteria.

## Docs to update

`docs/PROJECT-CONTEXT.md`: the "Winning & payment" paragraph (order creation math and the payment
path), and the `Scope` line that currently reads "Shipping is OUT of scope" — narrow it to "no
carrier/tracking/address; a flat $20 shipping fee is charged to the buyer and credited to the seller".

## Alternatives rejected

- **`Order.shippingFee` snapshot column.** History-safe and enables a real itemised receipt, but costs
  a migration (which on this repo means the `migrate diff` + `migrate deploy` workaround, see the
  migration-drift gotcha). Rejected for speed; revisit if the fee ever needs to vary.
- **Folding the fee into `Order.amount`.** `amount` means "auction closing price" and feeds the sold
  emails and the auction record. Corrupting it would misreport the sale.
- **Platform revenue instead of seller credit.** Would need a platform wallet or a new
  `WalletTxnType.FEE` plus a place to hold the money. Out of scope — the seller ships, the seller
  gets the shipping money.
- **Surfacing the fee on `GET /auctions/:id`.** Would let the mobile app show "+$20 shipping" before
  bidding. Deferred by decision to keep the change inside `orders`.
