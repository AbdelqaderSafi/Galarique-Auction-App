# Shipping Fee Implementation Plan

**Spec:** [docs/design/specs/2026-08-17-shipping-fee-design.md](../specs/2026-08-17-shipping-fee-design.md)

**Goal:** Charge every buyer a flat $20 shipping fee on top of the winning price and credit it to the seller.

**Architecture:** A hardcoded `SHIPPING_FEE` constant in `orders.service.ts`. `SettlementService` folds it
into `amountDue` when it creates an order; `OrdersService.payOrder()` compares the deposit against
`amount + SHIPPING_FEE` for the excess refund and credits the seller the money that **actually moved**
(`amountDue + depositApplied − excess`) rather than a recomputed price. No schema change, no migration,
no change to the `auctions` module.

**Tech Stack:** NestJS 11, Prisma 7 (`Prisma.Decimal` for all money), Jest + `jest-mock-extended`, Supertest.

## Global Constraints

- Money is always `Prisma.Decimal`. Never `number`, never float arithmetic.
- Do **not** add a column, a migration, or a Prisma schema change. Approach (b) was chosen deliberately.
- Do **not** touch the `auctions` module, the $50 deposit, the bid-time balance check, or the 72h window.
- Do **not** change any API request shape.
- Do **not** touch `mail.service.ts`. `sendPaymentRequired` prints `amountDue`, so it becomes
  fee-inclusive on its own; `sendOrderPaid` printing the item price is intentional.
- Unit tests must be run with `--runInBand` on this machine — parallel workers hit `Memory allocation error`
  on unrelated suites.
- **`npx tsc --noEmit` already fails on this repo** — pre-existing `mockImplementation` typing errors in
  `auctions.service.spec.ts` and `bids.service.spec.ts`. `tsconfig.build.json` excludes `**/*spec.ts`, so
  `npx nest build` is the real compile gate. Do not try to fix those errors here; they are out of scope.
- Arabic inline comments, matching the surrounding code in `orders`/`settlement`.
- **Commits require the user's explicit go-ahead.** Prepare each commit and ask; never `git commit` or
  `git push` unprompted.

---

### Task 1: Derive ledger amounts from money actually moved (pure refactor, no fee yet)

This lands the load-bearing change on its own, with no behaviour change, so the existing suite proves the
derivation is equivalent to the current `order.amount`.

**Files:**
- Modify: `src/modules/orders/orders.service.ts:96-157`
- Test: `src/modules/orders/orders.service.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a `netPaid` local inside `payOrder()`'s transaction, typed `Prisma.Decimal`, equal to
  `order.amountDue + order.depositApplied − excess`. Task 2 reuses `excess` being hoisted here.

- [ ] **Step 1: Write the failing test**

Add this to `src/modules/orders/orders.service.spec.ts` inside `describe('payOrder', ...)`, after the
existing second-chance test (currently ends at line 209):

```ts
    it('credits the seller the money that actually moved, not a recomputed price', async () => {
      // A row whose amountDue + depositApplied deliberately does NOT equal `amount`,
      // proving the credit is derived from the row and not from `order.amount`.
      const oddOrder = {
        ...baseOrder,
        amount: new Prisma.Decimal(999),
        depositApplied: new Prisma.Decimal(50),
        amountDue: new Prisma.Decimal(150),
      };
      prisma.order.findUnique.mockResolvedValue(oddOrder as any);
      prisma.wallet.upsert.mockImplementation((args: any) =>
        Promise.resolve({ id: args.where.userId === buyerId ? 'buyer-wallet' : 'seller-wallet' } as any),
      );
      prisma.wallet.updateMany.mockResolvedValue({ count: 1 } as any);
      prisma.order.update.mockResolvedValue({ ...oddOrder, status: OrderStatus.COMPLETED } as any);

      await service.payOrder(orderId, buyerId);

      expect(prisma.wallet.update).toHaveBeenCalledWith({
        where: { id: 'seller-wallet' },
        data: { balance: { increment: new Prisma.Decimal(200) } }, // 150 + 50, not 999
      });
      expect(prisma.walletTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            walletId: 'seller-wallet',
            type: WalletTxnType.SALE,
            amount: new Prisma.Decimal(200),
          }),
        }),
      );
    });
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx jest src/modules/orders/orders.service.spec.ts --runInBand -t "money that actually moved"
```

Expected: FAIL — the seller is credited `999` (from `order.amount`) instead of `200`.

- [ ] **Step 3: Hoist `excess` and introduce `netPaid`**

In `src/modules/orders/orders.service.ts`, replace the refund block (lines 97-113) with:

```ts
      // العربون أكبر من الثمن → رُدّ الفرق للمشتري
      let excess = new Prisma.Decimal(0);
      if (usesDeposit && order.depositApplied.greaterThan(order.amount)) {
        excess = order.depositApplied.minus(order.amount);
        await tx.wallet.update({
          where: { id: buyerWallet.id },
          data: { balance: { increment: excess } },
        });
        await tx.walletTransaction.create({
          data: {
            walletId: buyerWallet.id,
            type: WalletTxnType.REFUND,
            amount: excess,
            refId: order.id,
            note: 'Deposit exceeded the final price',
          },
        });
      }

      // ما خرج فعلياً من جيب المشتري — مشتق من الصف نفسه، مش من إعادة حساب السعر
      const netPaid = order.amountDue.plus(order.depositApplied).minus(excess);
```

- [ ] **Step 4: Use `netPaid` in the three ledger writes**

Still in `payOrder()`, change the buyer `PURCHASE` transaction (currently line 131) from
`amount: order.amount,` to:

```ts
          amount: netPaid,
```

Change the seller credit (currently line 147) from `increment: order.amount` to:

```ts
        data: { balance: { increment: netPaid } },
```

Change the seller `SALE` transaction (currently line 153) from `amount: order.amount,` to:

```ts
          amount: netPaid,
```

Leave both `note:` strings exactly as they are.

- [ ] **Step 5: Run the whole orders suite**

```bash
npx jest src/modules/orders/orders.service.spec.ts --runInBand
```

Expected: PASS, all tests including the new one. Every pre-existing test must still pass untouched —
that is the proof the refactor is behaviour-preserving.

- [ ] **Step 6: Typecheck and build**

```bash
npx nest build
```

Expected: no output — a silent `nest build` is a successful one.

- [ ] **Step 7: Prepare the commit and ask before running it**

```bash
git add src/modules/orders/orders.service.ts src/modules/orders/orders.service.spec.ts
git commit -m "refactor(orders): derive ledger amounts from the money that actually moved"
```

---

### Task 2: Introduce the $20 shipping fee

**Files:**
- Modify: `src/modules/orders/orders.service.ts` (constant + excess comparison)
- Modify: `src/modules/orders/settlement.service.ts:112-115` and `:327-339`
- Test: `src/modules/orders/orders.service.spec.ts`, `src/modules/orders/settlement.service.spec.ts`

**Interfaces:**
- Consumes: `netPaid` and the hoisted `excess` from Task 1.
- Produces: `export const SHIPPING_FEE: Prisma.Decimal` from `src/modules/orders/orders.service.ts`,
  imported by `settlement.service.ts`.

- [ ] **Step 1: Write the failing settlement tests**

In `src/modules/orders/settlement.service.spec.ts`, update the rank-1 assertion (currently line 115)
from `amountDue: new Prisma.Decimal(150), // 200 - 50` to:

```ts
          amountDue: new Prisma.Decimal(170), // 200 + 20 shipping - 50 deposit
```

Rename the clamp test (currently line 127) and add a partial-cover case next to it:

```ts
    it('clamps amountDue to 0 when price + shipping <= the $50 deposit', async () => {
      prisma.auction.findMany.mockResolvedValue([{ id: auctionId }] as any);
      prisma.auction.findUnique.mockResolvedValue(
        auctionRow({ currentPrice: new Prisma.Decimal(30) }) as any,
      );
      prisma.order.create.mockResolvedValue({
        id: 'order-1',
        paymentDeadline: new Date(),
      } as any);

      await service.closeDueAuctions();

      // 30 + 20 = 50, exactly the deposit → nothing left to pay
      expect(prisma.order.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ amountDue: new Prisma.Decimal(0) }),
      });
    });

    it('charges the shipping shortfall when the deposit only partly covers price + shipping', async () => {
      prisma.auction.findMany.mockResolvedValue([{ id: auctionId }] as any);
      prisma.auction.findUnique.mockResolvedValue(
        auctionRow({ currentPrice: new Prisma.Decimal(40) }) as any,
      );
      prisma.order.create.mockResolvedValue({
        id: 'order-1',
        paymentDeadline: new Date(),
      } as any);

      await service.closeDueAuctions();

      // 40 + 20 - 50 = 10
      expect(prisma.order.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ amountDue: new Prisma.Decimal(10) }),
      });
    });
```

In the second-chance assertion, change line 283 from `amountDue: new Prisma.Decimal(180),` to:

```ts
          amountDue: new Prisma.Decimal(200), // 180 + 20 shipping, no deposit to offset
```

Leave line 281 (`amount` is `180`) and line 282 (`depositApplied` is `0`) unchanged.

- [ ] **Step 2: Run them and confirm they fail**

```bash
npx jest src/modules/orders/settlement.service.spec.ts --runInBand
```

Expected: FAIL — `amountDue` comes back as `150`, `10` is `0`, and the second-chance row is `180`.

- [ ] **Step 3: Add the constant**

In `src/modules/orders/orders.service.ts`, directly under `DEPOSIT_AMOUNT` (line 20):

```ts
// رسوم شحن ثابتة على المشتري، بتروح للبائع (هو الي بشحن)
export const SHIPPING_FEE = new Prisma.Decimal(20);
```

- [ ] **Step 4: Fold the fee into order creation**

In `src/modules/orders/settlement.service.ts`, extend the import on line 18:

```ts
import {
  DEPOSIT_AMOUNT,
  PAYMENT_WINDOW_MS,
  SHIPPING_FEE,
  OrdersService,
} from './orders.service';
```

Replace the rank-1 math (lines 112-115) with:

```ts
      const amount = auction.currentPrice;
      const totalDue = amount.plus(SHIPPING_FEE);
      const amountDue = totalDue.greaterThan(DEPOSIT_AMOUNT)
        ? totalDue.minus(DEPOSIT_AMOUNT)
        : new Prisma.Decimal(0);
```

In the second-chance order creation (line 334), replace `amountDue: second.amount,` with:

```ts
          amountDue: second.amount.plus(SHIPPING_FEE), // ما في عربون، فالشحن بينضاف كامل
```

- [ ] **Step 5: Run the settlement suite**

```bash
npx jest src/modules/orders/settlement.service.spec.ts --runInBand
```

Expected: PASS.

- [ ] **Step 6: Write the failing payOrder tests**

In `src/modules/orders/orders.service.spec.ts`, make `baseOrder` a post-fee row — change line 34 from
`amountDue: new Prisma.Decimal(150),` to:

```ts
    amountDue: new Prisma.Decimal(170), // 200 + 20 shipping - 50 deposit
```

Update the insufficient-balance regex (line 104) from `\$150\.00` to:

```ts
        /Insufficient balance. Needed: \$170\.00, available: \$10\.00/,
```

In the happy-path test, the buyer `PURCHASE` (line 136), the seller credit (line 142) and the seller
`SALE` (line 146) currently assert `baseOrder.amount`. Change all three to `new Prisma.Decimal(220)`
(`170 + 50`), and retitle the test:

```ts
    it('happy path: debits amountDue, applies the deposit, credits the seller price + shipping, marks COMPLETED/SOLD', async () => {
```

Replace the cheap-item test (lines 161-186) with a genuinely post-fee cheap order:

```ts
    it('refunds the excess when the deposit exceeds price + shipping (price $25)', async () => {
      const cheapOrder = {
        ...baseOrder,
        amount: new Prisma.Decimal(25),
        depositApplied: new Prisma.Decimal(50),
        amountDue: new Prisma.Decimal(0),
      };
      prisma.order.findUnique.mockResolvedValue(cheapOrder as any);
      prisma.wallet.upsert.mockImplementation((args: any) =>
        Promise.resolve({ id: args.where.userId === buyerId ? 'buyer-wallet' : 'seller-wallet' } as any),
      );
      prisma.wallet.updateMany.mockResolvedValue({ count: 1 } as any);
      prisma.order.update.mockResolvedValue({ ...cheapOrder, status: OrderStatus.COMPLETED } as any);

      await service.payOrder(orderId, buyerId);

      // 50 deposit - (25 + 20) = 5 back to the buyer
      expect(prisma.wallet.update).toHaveBeenCalledWith({
        where: { id: 'buyer-wallet' },
        data: { balance: { increment: new Prisma.Decimal(5) } },
      });
      expect(prisma.walletTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: WalletTxnType.REFUND, amount: new Prisma.Decimal(5) }),
        }),
      );
      // seller nets 0 + 50 - 5 = 45 = 25 + 20 shipping
      expect(prisma.wallet.update).toHaveBeenCalledWith({
        where: { id: 'seller-wallet' },
        data: { balance: { increment: new Prisma.Decimal(45) } },
      });
    });
```

Update the second-chance test fixture (line 193) from `amountDue: new Prisma.Decimal(200),` to:

```ts
        amountDue: new Prisma.Decimal(220), // 200 + 20 shipping, no deposit
```

Finally add the legacy-row guard test at the end of `describe('payOrder', ...)`:

```ts
    it('settles a pre-fee legacy row at its original numbers (no invented $20)', async () => {
      // Created before the shipping fee existed: amountDue = amount - deposit, no fee inside.
      const legacyOrder = {
        ...baseOrder,
        amount: new Prisma.Decimal(200),
        depositApplied: new Prisma.Decimal(50),
        amountDue: new Prisma.Decimal(150),
      };
      prisma.order.findUnique.mockResolvedValue(legacyOrder as any);
      prisma.wallet.upsert.mockImplementation((args: any) =>
        Promise.resolve({ id: args.where.userId === buyerId ? 'buyer-wallet' : 'seller-wallet' } as any),
      );
      prisma.wallet.updateMany.mockResolvedValue({ count: 1 } as any);
      prisma.order.update.mockResolvedValue({ ...legacyOrder, status: OrderStatus.COMPLETED } as any);

      await service.payOrder(orderId, buyerId);

      // 150 + 50 = 200 — exactly what the buyer paid, no fee conjured out of nowhere
      expect(prisma.wallet.update).toHaveBeenCalledWith({
        where: { id: 'seller-wallet' },
        data: { balance: { increment: new Prisma.Decimal(200) } },
      });
    });
```

- [ ] **Step 7: Run them and confirm the cheap-item test fails**

```bash
npx jest src/modules/orders/orders.service.spec.ts --runInBand
```

Expected: FAIL on the `$25` refund test — the excess is still computed against `order.amount` (`50 − 25 = 25`),
so it refunds `25` instead of `5`. The other tests should already pass thanks to Task 1's derivation.

- [ ] **Step 8: Compare the deposit against the total, not the price**

In `src/modules/orders/orders.service.ts`, inside `payOrder()`, insert the total above the refund block
and swap the two comparisons:

```ts
      // إجمالي ما على المشتري = ثمن القطعة + الشحن
      const totalDue = order.amount.plus(SHIPPING_FEE);

      // العربون أكبر من الإجمالي → رُدّ الفرق للمشتري
      let excess = new Prisma.Decimal(0);
      if (usesDeposit && order.depositApplied.greaterThan(totalDue)) {
        excess = order.depositApplied.minus(totalDue);
```

Change the refund note in that same block to:

```ts
            note: 'Deposit exceeded the total due',
```

Leave `netPaid`, the `PURCHASE` note and the `SALE` note exactly as Task 1 left them.

- [ ] **Step 9: Run the full unit suite**

```bash
npm test -- --runInBand
```

Expected: PASS — 17 suites, all tests green (the count grows by the tests added in Tasks 1 and 2).

- [ ] **Step 10: Typecheck and build**

```bash
npx nest build
```

Expected: no output — a silent `nest build` is a successful one.

- [ ] **Step 11: Prepare the commit and ask before running it**

```bash
git add src/modules/orders/orders.service.ts src/modules/orders/settlement.service.ts src/modules/orders/orders.service.spec.ts src/modules/orders/settlement.service.spec.ts
git commit -m "feat(orders): charge a flat \$20 shipping fee to the buyer, credited to the seller"
```

---

### Task 3: Update the integration and system test expectations

**Files:**
- Modify: `test/integration/auction-lifecycle.integration-spec.ts:258-276` and `:311`, `:340`
- Modify: `scripts/test-orders.mjs:115`, `:121`, `:131`, `:220`

**Interfaces:**
- Consumes: the behaviour shipped in Task 2. Nothing produced for later tasks.

Every number below is derived from `amountDue = price + 20 − deposit` and `seller = amountDue + deposit − excess`.

- [ ] **Step 1: Update the first integration test (auction sells at $150)**

In `test/integration/auction-lifecycle.integration-spec.ts`, line 260:

```ts
    expect(order.amountDue).toBe('120.00'); // 150 + 20 shipping - 50 deposit
```

Lines 262-263 comment and line 270:

```ts
    // B had $450 balance + $50 locked; auto-pay should already have completed it
    // (amountDue=120 <= balance=450), so it's COMPLETED, not AWAITING_PAYMENT.
    expect(order.status).toBe('COMPLETED');

    const walletBFinal = await request(server())
      .get('/wallet')
      .set('Authorization', `Bearer ${buyerB.token}`);
    // 450 - 120 (amountDue) = 330; lockedBalance 50 -> 0 (deposit applied)
    expect(walletBFinal.body).toEqual({ balance: '330.00', lockedBalance: '0.00', currency: 'USD' });
```

Lines 275-276:

```ts
    // Seller gets the price + the $20 shipping immediately, no escrow
    expect(sellerWallet.body.balance).toBe('170.00');
```

Leave line 258 (`order.amount` is `'150.00'`) and line 259 (`depositApplied` is `'50.00'`) unchanged —
neither is affected by the fee.

- [ ] **Step 2: Update the second integration test (winner defaults, second chance)**

Line 311's comment:

```ts
    // A won at $200 but only had the $50 deposit -> amountDue=$170, auto-pay fails -> AWAITING_PAYMENT
```

Line 340, inside the second-chance `toMatchObject`:

```ts
      amountDue: '120.00', // 100 bid + 20 shipping, no deposit
```

Line 329 (`walletAFinal` is `0.00`/`0.00`) stays as-is — the deposit is forfeited either way.

- [ ] **Step 3: Run the integration suite**

```bash
npm run test:integration
```

Expected: PASS, 8 tests. This needs the local `galleryq_test` Postgres DB and `.env.test`.

- [ ] **Step 4: Update the system-test expectations**

In `scripts/test-orders.mjs`, line 115 (winner seeded with $450, auction at $200):

```js
  check('wallet', 'winner balance 280 (450-170) after auto-pay', w?.balance === '280.00', JSON.stringify(w));
```

Line 121 (seller nets `170 + 50 = 220`):

```js
  check('wallet', 'seller balance includes +220 from funded-winner sale', Number(sw.balance) >= 220, JSON.stringify(sw));
```

Line 131:

```js
  check('GET /orders/sales', 'unfunded-winner amountDue 170.00', unfundedOrder?.amountDue === '170.00', JSON.stringify(unfundedOrder));
```

Line 220 — the cheap auction is seeded at `$20` (`scripts/seed-orders-test.ts:191`), so the excess is now
`50 − (20 + 20) = 10` instead of `30`:

```js
  check('wallet', 'cheapWinner net +10 refund (450 seed -> 460)', cw?.balance === '460.00', JSON.stringify(cw));
```

Line 218 (`cheap order amountDue 0.00`) and line 201 (`second pays ... at $150`, which asserts
`order.amount`, not `amountDue`) both stay unchanged.

- [ ] **Step 5: Run the system tests**

Build, boot against `.env.system-test`, then:

```bash
node scripts/run-system-tests.mjs
```

Expected: every check passes. See `docs/testing-report.md` §4 for the exact boot commands.

- [ ] **Step 6: Prepare the commit and ask before running it**

```bash
git add test/integration/auction-lifecycle.integration-spec.ts scripts/test-orders.mjs
git commit -m "test: update order settlement expectations for the shipping fee"
```

---

### Task 4: Update the project docs and run the pre-deploy safety check

**Files:**
- Modify: `docs/PROJECT-CONTEXT.md` (the `Scope` line ~31 and the "Winning & payment" paragraph ~60)

**Interfaces:**
- Consumes: everything above. Terminal task.

- [ ] **Step 1: Narrow the scope line**

In `docs/PROJECT-CONTEXT.md`, line ~31, replace `**Shipping is OUT of scope.**` with:

```markdown
**Shipping logistics are OUT of scope** (no carrier, tracking, address, or shipment states) — but a **flat $20 shipping fee** is charged to the buyer and credited to the seller; see Winning & payment.
```

- [ ] **Step 2: Record the money model in "Winning & payment"**

In the same file, in the "Winning & payment" paragraph (~line 60), replace the parenthesised order-creation
math `(`offerRank=1`, `amount=currentPrice`, `depositApplied=50`, `amountDue=max(0, amount-50)`, `paymentDeadline=+72h`)`
with:

```markdown
(`offerRank=1`, `amount=currentPrice`, `depositApplied=50`, `amountDue=max(0, amount+20-50)`, `paymentDeadline=+72h`)
```

Then append to the end of that paragraph:

```markdown
**Flat $20 shipping fee (added 2026-08-17, see `docs/design/specs/2026-08-17-shipping-fee-design.md`):** every order charges the buyer `amount + $20` and credits the **seller** the same total — the seller ships, so the seller gets the shipping money. It is a hardcoded `SHIPPING_FEE` constant in `orders.service.ts` (**no column, no migration** — deliberate; the trade-off is that an order row cannot say how much of its `amountDue` was shipping). `amountDue = max(0, amount + 20 − depositApplied)` at both order-creation sites, and the excess refund fires when the deposit exceeds `amount + 20`. Critically, `payOrder()` credits the seller **`netPaid = amountDue + depositApplied − excess`** — the money that actually moved — *not* `amount + SHIPPING_FEE`: rows created before 2026-08-17 stored a fee-free `amountDue`, and recomputing from the constant would credit the seller $20 nobody paid. The one residual gap is the excess-refund branch, which reads the constant and so under-refunds a *pre-fee* rank-1 row priced under $50 (by $20 below $30, by `50 − amount` between $30 and $50); the pre-deploy check `SELECT count(*) FROM "Order" WHERE status='AWAITING_PAYMENT' AND "offerRank"=1 AND amount < 50` returning 0 rules it out entirely. Buyer-facing exposure is order-level only — `GET /auctions` and `/auctions/:id` carry no fee field, so the mobile app must not show a shipping line before an order exists.
```

- [ ] **Step 3: Run the pre-deploy safety check against production**

Before anything is deployed to Railway:

```bash
psql "$DIRECT_URL" -c "SELECT count(*) FROM \"Order\" WHERE status = 'AWAITING_PAYMENT' AND \"offerRank\" = 1 AND amount < 50;"
```

Expected: `0`. If it is non-zero, list those orders and settle or cancel them **before** deploying —
do not add a `createdAt` cutoff to the code.

- [ ] **Step 4: Full verification sweep**

```bash
npm test -- --runInBand && npm run test:integration && npx nest build
```

Expected: all unit tests pass, all 8 integration tests pass, successful build.

- [ ] **Step 5: Prepare the final commit and ask before running it**

```bash
git add docs/PROJECT-CONTEXT.md docs/design/specs/2026-08-17-shipping-fee-design.md docs/design/plans/2026-08-17-shipping-fee.md
git commit -m "docs: record the flat \$20 shipping fee decision and money model"
```
