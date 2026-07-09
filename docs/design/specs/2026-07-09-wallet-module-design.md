# Wallet module — design spec (2026-07-09)

Backend module for the GalleryQ auctions app. Adds the user **wallet** (balance +
ledger) and the two Stripe money rails: **top-up via Stripe Checkout + webhook** and
**withdrawal via Stripe Connect Express (synchronous Transfer)**. Must land before
`bids` (a bid holds a $50 deposit from the wallet).

Follows the project conventions in `docs/PROJECT-CONTEXT.md` exactly: inject `DatabaseService`,
Zod + `ZodValidationPipe`, DTO classes with `@ApiProperty`, a separate swagger file,
global `AuthGuard`/`RolesGuard` (`@IsPublic`/`@Roles`), module registered in
`app.module`.

## Agreed decisions

| Decision | Choice |
|---|---|
| Top-up mechanism | **Stripe Checkout** (server creates a Checkout Session, returns `checkoutUrl`). Switched away from PaymentIntent. |
| Confirmation | **Webhook only** (`checkout.session.completed`), not the client redirect. |
| Idempotency | **`stripeEventId String? @unique`** column on `WalletTransaction`. Duplicate event → Prisma **P2002** → treated as already processed. |
| Withdrawal execution | **Synchronous Stripe Connect Transfer**; mark `PAID`/`FAILED` immediately. |
| Connect + withdraw access | **Any authenticated user** (not SELLER-gated). |
| Limits | **Minimal**: `amount > 0` (2 dp); withdraw also `≤ available balance`. No upper cap. |
| Currency | **USD** only. |

Because withdrawals execute synchronously and Connect status is fetched on demand,
**the webhook only needs to handle `checkout.session.completed`** — every handled
event creates a `TOPUP` txn, so the unique column fully covers idempotency.

## Schema change (one migration)

Add to `WalletTransaction`:

```prisma
stripeEventId String? @unique // معرّف حدث Stripe لمنع الشحن المكرر (idempotency)
```

Migration name: `wallet_txn_stripe_event_id`. Everything else already exists in
`schema.prisma`: `Wallet` (balance/lockedBalance), `WalletTransaction`
(`WalletTxnType` incl. `TOPUP`/`WITHDRAW`, amount, refId, note), `Withdrawal`
(`WithdrawalStatus` PENDING/PAID/FAILED, stripePayoutId), `User.stripeCustomerId`/
`stripeConnectId`.

## Files

```
src/modules/wallet/
  wallet.controller.ts               # 7 routes under /wallet
  wallet.service.ts                  # DB + orchestration (balance, ledger, withdraw flow)
  stripe.service.ts                  # lazy Stripe SDK wrapper (like UploadsService)
  wallet.module.ts                   # providers [WalletService, StripeService], exports [WalletService]
  dto/wallet.dto.ts                  # TopUpDto, WithdrawDto (classes + @ApiProperty) + response types
  util/wallet.validation.schema.ts   # Zod: topupSchema, withdrawSchema
src/swagger/wallet.swagger.ts        # applyDecorators per endpoint + SwaggerWalletTag()
```

Edits: `main.ts` (`rawBody: true`), `app.module.ts` (register `WalletModule`),
`prisma/schema.prisma` (+migration), `src/types/declartion-mergin.ts` (env types),
`.env.example` (Stripe vars already present).

## Endpoints (controller `/wallet`, tag `Wallet`)

| # | Method & path | Guard | Body / Query | Returns |
|---|---|---|---|---|
| 1 | `GET /wallet` | 🔒 any auth | — | `{ balance, lockedBalance, currency:"USD" }` (get-or-creates wallet) |
| 2 | `GET /wallet/transactions` | 🔒 any auth | `?page&limit` | `{ items, page, limit, total }` |
| 3 | `POST /wallet/topup` | 🔒 any auth | `{ amount }` | `{ checkoutUrl }` |
| 4 | `POST /wallet/stripe/webhook` | 🌐 `@IsPublic(true)` | raw body + `stripe-signature` | `{ received:true }` |
| 5 | `POST /wallet/connect/onboard` | 🔒 any auth | — | `{ url }` |
| 6 | `GET /wallet/connect/status` | 🔒 any auth | — | `{ detailsSubmitted, chargesEnabled, payoutsEnabled }` |
| 7 | `POST /wallet/withdraw` | 🔒 any auth | `{ amount }` | `{ withdrawalId, status }` |

## Money flows

**Top-up.** `POST /wallet/topup` → `StripeService.createCheckoutSession(userId, cents)`
(`mode:"payment"`, one line item `unit_amount = round(amount*100)`, `currency:"usd"`,
`metadata.userId`, success/cancel URLs from `FRONTEND_URL`) → returns `checkoutUrl`.
Client redirects to Stripe. **Confirmation is webhook-only.**

**Webhook.** `POST /wallet/stripe/webhook` reads the **raw body** and the
`stripe-signature` header, calls `stripe.webhooks.constructEvent(rawBody, sig,
STRIPE_WEBHOOK_SECRET)`. Bad/missing signature → `400`. On
`checkout.session.completed` with `payment_status === "paid"`: read `metadata.userId`
and `amount_total`, then in **one DB transaction**:
1. get-or-create the user's wallet,
2. `walletTransaction.create({ type:TOPUP, amount, stripeEventId:event.id, refId:session.id, note })`,
3. `wallet.update({ balance: { increment: amount } })`.

Insert + credit share the transaction, so a duplicate event (same `event.id`) hits the
unique constraint → **P2002** → caught → respond `200 { received:true }` with no
double-credit. Unknown event types are ignored (`{ received:true }`).

**Withdrawal (synchronous Transfer).** `POST /wallet/withdraw { amount }`:
1. Validate `amount > 0`.
2. Require `stripeConnectId`; retrieve the account and require `payouts_enabled` (else `400`).
3. Atomic guarded debit: `wallet.updateMany({ where:{ userId, balance:{ gte: amount } }, data:{ balance:{ decrement: amount } } })`. `count === 0` ⇒ `400` insufficient balance.
4. Create `Withdrawal { status: PENDING, amount }`.
5. Call `stripe.transfers.create({ amount:cents, currency:"usd", destination: stripeConnectId })`.
   - **Success** → `Withdrawal → PAID` (+`stripePayoutId = transfer.id`) **and** `walletTransaction.create({ type:WITHDRAW, amount, refId: withdrawalId })`.
   - **Failure** → `Withdrawal → FAILED` **and refund** `wallet.update({ balance: { increment: amount } })` (no WITHDRAW txn).

The ledger only ever records **successful** withdrawals. Balance is debited on request
and restored on failure.

**Connect onboarding.** `POST /wallet/connect/onboard`: if the user has no
`stripeConnectId`, create an Express account (`stripe.accounts.create({ type:"express" })`)
and persist the id on the user; always return a fresh account link
(`stripe.accountLinks.create({ account, type:"account_onboarding", return_url, refresh_url })`
from `FRONTEND_URL`).

**Connect status.** `GET /wallet/connect/status`: if no `stripeConnectId` →
`{ detailsSubmitted:false, chargesEnabled:false, payoutsEnabled:false }`; else retrieve
the account and map `details_submitted`/`charges_enabled`/`payouts_enabled`.

All amounts stored as `Prisma.Decimal(amount.toFixed(2))`; Stripe receives
`Math.round(amount * 100)` cents.

## Raw body wiring (no other route breaks)

`NestFactory.create(AppModule, { rawBody: true })` in `main.ts`. Nest keeps the normal
JSON body parser for every route **and** additionally exposes `request.rawBody` (Buffer).
The webhook handler reads `@Req() req: RawBodyRequest<Request>` → `req.rawBody`. No
`express.raw()` needed; other routes are unaffected.

## StripeService (lazy client, like UploadsService)

- `private client: Stripe | null`. `getClient()` throws `ServiceUnavailableException`
  if `STRIPE_SECRET_KEY` is missing; otherwise `new Stripe(secretKey)` (SDK-pinned API
  version — no explicit `apiVersion` to avoid literal-type friction).
- Methods: `createCheckoutSession`, `constructEvent`, `createConnectAccount`,
  `createAccountLink`, `retrieveAccount`, `createTransfer`.
- `constructEvent` uses `STRIPE_WEBHOOK_SECRET`; throws `BadRequestException` on
  verification failure.

## Env

Add to `EnvVariables`: `STRIPE_SECRET_KEY: string`, `STRIPE_WEBHOOK_SECRET: string`
(both already in `.env.example`). Reuse existing `FRONTEND_URL` for redirect URLs.
Local `.env` gets the real `sk_test_...`; `STRIPE_WEBHOOK_SECRET` from `stripe listen`
at test time.

## Validation & errors

- Zod `topupSchema` / `withdrawSchema`: `amount` is a positive number, `multipleOf 0.01`
  (2 dp). Applied via `ZodValidationPipe` on the body.
- Missing Stripe config → `503 ServiceUnavailable`. Bad webhook signature → `400`.
  Insufficient balance / payouts not enabled → `400`. Wallet auto-created on first access.

## Testing plan

`tsc` + `nest build`, boot, exercise all 7 endpoints: auth (401 without JWT), validation
(`amount ≤ 0` → 400), happy paths. **Webhook fully testable offline**: with a chosen
`STRIPE_WEBHOOK_SECRET`, craft an HMAC-signed `checkout.session.completed` payload →
assert wallet credited; **replay the same event** → assert no double-credit; invalid
signature → 400. Live Stripe-API endpoints (topup/connect/withdraw) exercised with the
real `sk_test_...` key.

## Out of scope

Deposit hold/release (belongs to `bids`), escrow in/out (belongs to `orders`), saved
cards, multi-currency, admin withdrawal review (withdrawals are synchronous here).
