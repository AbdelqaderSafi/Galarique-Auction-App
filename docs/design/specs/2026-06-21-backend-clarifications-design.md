# GalleryQ Backend — Clarified Design (Brainstorming Outcome)

> Status: **agreed** — 2026-06-21
> Complements [docs/ANALYSIS.md](../../ANALYSIS.md). Captures the decisions clarified in the brainstorming session and the resulting schema / integration changes. Source of truth for the remaining modules.

## Scope

- Approved design = the **`buyer flow AI`** Figma page only (contains buyer **and** seller screens). `seller flow AI` ignored.
- **Shipping is out of scope** (no carrier/tracking/shipment states).
- Single currency: **USD ($)**.

## Key decisions

| # | Topic | Decision |
|---|-------|----------|
| 1 | Auction publication | `DRAFT` → `PENDING_REVIEW` → **admin approval** → live, or `REJECTED` |
| 2 | Auction timing | Seller picks a **preset duration** (default options: 3 / 5 / 7 / 10 days); auction goes `LIVE` at the moment of admin approval; `endTime = approvedAt + duration` |
| 3 | Reviewer | **ADMIN** reviews the auction and sets the (private) estimated value — no separate EXPERT role |
| 4 | Currency | USD only |
| 5 | Images | Backend receives files (multer) and uploads to **ImageKit**, stores the returned URL |
| 6 | Seller verification | **Phone OTP** for a Palestinian number (`+970`/`+972`). Successful verification grants the `SELLER` role. **Replaces** the old ID-document + admin review |
| 7 | OTP delivery | **Mock/console** sender (full OTP logic; pluggable real provider later) |
| 8 | Notifications | **Email only** (no in-app notification table) |
| 9 | Email delivery | **Nodemailer + SMTP** (Gmail / Mailtrap) |
| 10 | Wallet top-up | **Stripe PaymentIntent + webhook** → credit wallet on confirmed event |
| 11 | Withdrawal | **Stripe Connect / Payouts** to the seller's connected account |

## Flows

### Seller onboarding (phone OTP)
1. Logged-in user submits a Palestinian phone number (validate `+970`/`+972` prefix).
2. Backend generates a 6-digit OTP (short expiry, limited attempts), stores it, "sends" it (mock = log).
3. User submits the code → backend verifies (match, not expired, attempts left) → records the verified phone on `SellerProfile` and grants the `SELLER` role.
4. The user can now create auctions (each auction still needs admin approval to go live).

### Auction lifecycle
```
DRAFT ──submit──► PENDING_REVIEW ──admin approve──► LIVE ──endTime──► ENDED ──► SOLD / UNSOLD
                       │
                       └── admin reject ──► REJECTED
```
- Seller builds the auction via the 4-step wizard (Category → Images → Details → Set Value) and may save as `DRAFT`.
- On submit → `PENDING_REVIEW`. Admin reviews, sets `estimatedValue` (private), then approves or rejects (`rejectionReason`).
- On approval: `status = LIVE`, `startTime = now`, `endTime = now + durationDays`.
- Anti-snipe: a bid within `antiSnipeSeconds` of `endTime` extends `endTime` by `extendBySeconds`.

### Wallet & payments
- **Top-up:** client requests top-up → backend creates a Stripe **PaymentIntent** → client confirms → Stripe **webhook** (`payment_intent.succeeded`) → backend credits `wallet.balance` + `WalletTransaction(TOPUP)`. Needs `stripeCustomerId` on the user and a verified webhook (`STRIPE_WEBHOOK_SECRET`).
- **Bidding deposit:** flat **$50** held on the user's first bid in an auction (`balance → lockedBalance`, `DEPOSIT_HOLD`). Lost → released; won-but-unpaid → forfeited.
- **Escrow:** winner pays → funds held in platform escrow (`PAID_IN_ESCROW`, `ESCROW_IN`). Released to seller when the buyer confirms receipt, or auto-released **14 calendar days** after payment if no dispute (`ESCROW_RELEASE`). Dispute → frozen (`DISPUTED`) → ADMIN resolves (release / refund).
- **Withdrawal:** seller onboards to **Stripe Connect**; withdrawal creates a transfer/payout to the connected account (`Withdrawal` record + `WITHDRAW`).

## Schema changes (delta from current)

1. **`AuctionStatus`** — add `PENDING_REVIEW`, `REJECTED`.
2. **`Auction`** — add `durationDays` (chosen preset), `reviewedById`, `reviewedAt`, `rejectionReason`. `startTime`/`endTime` become nullable until approval (set on approve).
3. **`SellerProfile`** — **remove** `idNumber`, `idImageUrl`, `status`, `address`; keep `phoneNumber`, add `phoneVerifiedAt`. (Remove `VerificationStatus` enum if unused.)
4. **`PhoneVerification`** (new) — `userId`, `phone`, `codeHash`, `expiresAt`, `attempts`, `consumedAt`.
5. **`User`** — add `stripeCustomerId?` (top-up), `stripeConnectId?` (payouts).
6. **`Withdrawal`** (new) — `userId`, `amount`, `status` (PENDING/PAID/FAILED), `stripePayoutId?`, timestamps.
7. Notifications: **no tables** — a `MailService` sends transactional emails on events (outbid, won, approved/rejected, payment reminder, order completed, escrow released).

## New env vars
`IMAGEKIT_PUBLIC_KEY`, `IMAGEKIT_PRIVATE_KEY`, `IMAGEKIT_URL_ENDPOINT` · `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_*` · `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` · `OTP_EXP_MINUTES`, `OTP_MAX_ATTEMPTS`

## Modules & build order
Built: `auth`, `user`, `database`, `categories` (✅ verified).
Next: `mail` (Nodemailer, used by later modules) → `uploads` (ImageKit) → `seller-verification` (phone OTP, gates seller actions) → `objects` → `auctions` (+ admin review) → `bids` (+ deposit, concurrency, anti-snipe) → `wallet` (Stripe top-up + webhook + Connect payouts) → `orders` (escrow) → `disputes` → `favorites` / `follows` → `scheduler` (close auctions, 72h payment + second-chance, 14-day auto-release).

> Note: notification emails are wired into each module's events as those modules are built (not a separate pass).

## Out of scope
Shipping/tracking, saved payment cards, in-app chat, in-app notifications, separate EXPERT role, multi-currency.
