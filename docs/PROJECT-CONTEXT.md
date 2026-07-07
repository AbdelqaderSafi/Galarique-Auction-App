# GalleryQ / Gallerique — Backend Project Context

Art & collectibles **auctions** mobile app (graduation project). This repo is the **entire backend**; a separate team builds the Flutter/mobile app in parallel against the deployed API. Brand tagline: "Bid Smart. Win Big."

- **Stack:** NestJS 11 · Prisma 7 · PostgreSQL · TypeScript.
- **Deployed:** API on **Railway**, DB on **Neon**. Base URL: `https://galarique-auction-app-production.up.railway.app` · Swagger: `/api/docs`.
- **Source of truth for data model:** `prisma/schema.prisma`. Full analysis: `docs/ANALYSIS.md`. Design decisions: `docs/design/specs/2026-06-21-backend-clarifications-design.md`.

---

## Code conventions (follow these exactly — match existing modules)

- **Prisma access:** inject `DatabaseService` (extends `PrismaClient`, provided by the `@Global() DatabaseModule`) — conventionally named `prisma`. Do NOT import a new PrismaClient.
- **Types/enums:** import from `generated/prisma/client` (custom generator output at `generated/prisma`), e.g. `import { Role } from 'generated/prisma/client'`.
- **Validation:** Zod schema per module in `src/modules/<m>/util/<m>.validation.schema.ts`, applied with `ZodValidationPipe` (`src/pipes/zod.validation.pipe.ts`) on the `@Body()`.
- **DTOs:** request DTOs are **classes** with `@ApiProperty` in `src/modules/<m>/dto/<m>.dto.ts`; response shapes are exported `type`s.
- **Swagger:** extract endpoint decorators into `src/swagger/<m>.swagger.ts` using `applyDecorators(...)` (see `src/swagger/auth.swagger.ts` / `categories.swagger.ts`). Tag with a `SwaggerXTag()` helper.
- **Module shape:** `@Module({ controllers, providers, exports })`; register the module in `src/app.module.ts` `imports`.
- **Auth is global:** `AuthGuard` + `RolesGuard` are registered as `APP_GUARD` in `AuthModule`, so **every route is protected by default**.
  - Open a route with `@IsPublic(true)` (`src/decorators/public.decorator.ts`).
  - Restrict by role with `@Roles([Role.ADMIN])` (`src/decorators/roles.decorator.ts`). `req.user` is the user without password (includes `roles`).
- **Passwords:** hashed with **argon2**. **JWT** via `@nestjs/jwt`, payload `{ sub, roles }`, 30-day expiry.
- **Money:** always `Decimal(12,2)` in Prisma (never Float). Currency is **USD** only.
- **main.ts:** `app.enableCors()`, listen on `process.env.PORT ?? 3000` bound to `0.0.0.0`, Swagger mounted at `api/docs`.
- **Per-module workflow:** agree scope → build (DTO+Zod+service+controller+swagger+module, register in app.module) → `tsc`+`nest build` → boot and test EVERY endpoint (happy path + auth/role/validation) → commit (user decides push).

---

## Domain model & product decisions (agreed — do not re-litigate)

**Scope:** Only the Figma page `buyer flow AI` is approved (it holds both buyer & seller screens). **Shipping is OUT of scope.** No saved cards, no in-app chat, no in-app notifications, no separate EXPERT role, no multi-currency.

**Object vs Auction:** `Object` = the permanent artwork (owner, `category` **enum**, title, description, era, condition, originality, authenticity, country, dimensions, images, status). `Auction` = a timed event on an Object. Create wizard: Category → Images → Details → Set Value (`estimatedValue` private/admin-only, `reservePrice` optional).

**Categories:** a fixed **enum** `Category` (`ART, WATCHES, COLLECTIBLES, JEWELRY, FURNITURE, BOOKS, FASHION, ELECTRONICS`) — NOT a table. `GET /categories` (public) returns the `{ value, label }` list.

**Auction lifecycle:** `DRAFT` → (submit) `PENDING_REVIEW` → **ADMIN approves** → `LIVE` (`startTime=now`, `endTime=now+durationDays`) → `ENDED` → `SOLD`/`UNSOLD`; or ADMIN `REJECTED` (+`rejectionReason`). Seller picks a **preset `durationDays`** (3/5/7/10). ADMIN sets the private `estimatedValue`. Anti-snipe: a bid within `antiSnipeSeconds` (default 60) of `endTime` extends it by `extendBySeconds` (default 60).

**Bidding:** free amount, must be `≥ currentPrice + minBidIncrement`. A **flat $50 deposit** is held on a user's **first** bid in an auction (`balance → lockedBalance`, `AuctionDeposit` HELD, `WalletTransaction` DEPOSIT_HOLD). "You pay only if you win." Do the whole bid inside a **DB transaction** (concurrency). Losers' deposits → RELEASED.

**Winning & payment:** on close, highest bid ≥ reserve → winner gets an `Order` (`AWAITING_PAYMENT`, `paymentDeadline = now+72h`), `amountDue = finalPrice − 50`. Unpaid within 72h → deposit FORFEITED + **second-chance** offer to the next-highest bidder (cascade via `offerRank`); if none pay → `UNSOLD`, Object returns to owner.

**Escrow (no shipping):** payment → funds held in platform escrow (`Order.status = PAID_IN_ESCROW`, `WalletTransaction` ESCROW_IN). Released to seller when the **buyer confirms receipt**, or **auto-released 14 calendar days** after payment (`autoReleaseAt = paidAt + 14d`) if no dispute → `COMPLETED` (ESCROW_RELEASE). Buyer can raise a **Dispute** → `DISPUTED` (funds frozen) → **ADMIN** resolves: release to seller (`RESOLVED_SELLER`) or refund buyer (`RESOLVED_BUYER` → `REFUNDED`).

**Wallet:** `balance` (available/withdrawable) + `lockedBalance` (pending $50 deposits). Escrow amounts tracked at the Order level. Every movement logged in `WalletTransaction`.

**Payments (Stripe, USD):** wallet **top-up** = Stripe **PaymentIntent + webhook** (`payment_intent.succeeded` → credit wallet). **Withdrawal** = **Stripe Connect / Payouts** to the seller's connected account (`Withdrawal` model, `WithdrawalStatus`). Add `stripeCustomerId` / `stripeConnectId` on User. **No saved cards** (one-time top-up).

**Seller verification = phone OTP over WhatsApp (built):** any authenticated user submits a **Palestinian** phone (`+970`/`+972`, mobile prefix 59/56) → `POST /seller/request-verification` → 6-digit OTP sent via **WhatsApp (Baileys 6.7.x, free, unofficial)** → `POST /seller/verify-phone` creates `SellerProfile` (`phoneNumber`, `phoneVerifiedAt`) and **grants the `SELLER` role**. Also `POST /seller/resend` and `GET /seller/whatsapp/status` (ADMIN). The `whatsapp` module (`@Global`) loads Baileys via dynamic `import()` (ESM) and is **resilient** — if WhatsApp isn't linked it logs the code to the console. Link via **pairing code** (`WHATSAPP_PAIRING_NUMBER`) or QR; session persists to `./wa-auth` (gitignored; needs a Railway Volume to survive redeploys). Uses the existing `PhoneVerification` model. (Firebase SMS was built then dropped because it's paid.)

**Images (built):** the `uploads` module receives files (multer) and uploads to **ImageKit** (`IMAGEKIT_PUBLIC_KEY` / `IMAGEKIT_PRIVATE_KEY` / `IMAGEKIT_URL_ENDPOINT`), stores the returned URL. Object creation takes image URLs (upload first, then send URLs — two steps).

**Notifications (built as `mail`):** **email only** via **Brevo HTTP API** (`BREVO_API_KEY`, `MAIL_FROM`; sender must be a Brevo *verified sender*). The `MailService` is resilient — logs the content if the key is missing. Wire emails into each module's events (outbid, auction approved/rejected, won, payment reminder, order completed, escrow released). Buyer↔seller contact is via `mailto:` (no chat).

**Guest:** browse only; bidding/following/favoriting require auth. **Favorites:** `FavoriteObject`, `FavoriteAuction`, and `Follow` (= Fav Sellers).

**Auth (built, full):** `register` does NOT create the user immediately — it emails a 6-digit code and stores the pending signup in the `EmailVerification` model; `verify-email` checks the code and only THEN creates the `User` + issues a JWT. Also: `resend-verification`, `login`, `google`, `validate` (🔒, renews the JWT + returns the user), `forgot-password` (random 32-byte reset token, 1h, `resetToken`/`resetTokenExpiry` on User; generic response — no user enumeration), `reset-password`, `change-password` (🔒, needs current password). OTP settings from `OTP_EXP_MINUTES` / `OTP_MAX_ATTEMPTS`.

**Admin:** no separate login — everyone uses `POST /auth/login`; `roles` containing `ADMIN` gates `@Roles([ADMIN])`. Public `register` always creates `[BUYER]`. Admins are created by **`npm run seed`** (`prisma/seed.ts`, uses raw `pg` + argon2 — NOT the Prisma client, see gotcha) from `ADMIN_EMAIL`/`ADMIN_PASSWORD`/`ADMIN_FULLNAME`.

---

## Modules

**Built:** `auth` (full — see above), `user` (service only), `database` (`@Global`), `mail` (Brevo), `uploads` (ImageKit), `whatsapp` (`@Global`, Baileys), `seller-verification` (WhatsApp OTP → SELLER), `categories` (GET public — fixed enum list), `objects` (seller artwork CRUD).

**Roadmap (remaining, in order):** `auctions` (+ admin review) → `wallet` (balance/hold + Stripe top-up/webhook + Connect payouts) → `bids` (+ $50 deposit, anti-snipe, concurrency) → `orders` (escrow) → `disputes` → `favorites`/`follows` → `scheduler` (close auctions, 72h payment + second-chance, 14-day auto-release). Note: `wallet` must come before `bids` (bids hold the deposit from the wallet). Add notification emails as each module is built.

**Schema note:** `EmailVerification` (pending signups) and `PhoneVerification` (seller OTP) are OTP tables; `SellerProfile` is phone-based (`phoneNumber` unique + `phoneVerifiedAt`); `User` has `resetToken`/`resetTokenExpiry` + `stripeCustomerId`/`stripeConnectId`; `Object.category` is a `Category` enum column.

---

## Current status & pending decisions (2026-07-06)

- **Done through:** `objects` module + Category-as-enum (committed `633867f`, **not pushed**). Everything before it is committed.
- **Next module:** `auctions` (create from an AVAILABLE object → `PENDING_REVIEW` → admin approve sets `LIVE` + `endTime`, or reject → public browse + detail).
- **Pending decision — refresh tokens:** a teammate wants automatic token refresh. Today `GET /auth/validate` just renews a single **30-day** JWT while it's still valid (sliding session; can't renew once expired). Options to build later: (a) stateless refresh JWT — simple, not revocable; (b) stored/rotating refresh token — revocable, needs a `RefreshToken` model + migration + `POST /auth/refresh`, and login/register/google would return `{ accessToken (short), refreshToken }`. **Changing the login response shape affects the mobile team — coordinate first.** Not yet decided or built.

---

## Local dev

- `npm run dev` — watch mode. `npm run seed` — create/refresh the admin. Swagger at `http://localhost:3000/api/docs`.
- **Migrations:** `npx prisma migrate dev --name <x>` (works in a normal interactive terminal). Then `npx prisma generate` if needed.
- **`.env`** currently points at **Neon** (secrets live here; it is gitignored). See `.env.example` for every var: `DATABASE_URL` (pooled), `DIRECT_URL` (direct), `JWT_SECRET`, `GOOGLE_CLIENT_ID`, `FRONTEND_URL`, `BREVO_API_KEY`, `MAIL_FROM`, `IMAGEKIT_*`, `OTP_EXP_MINUTES`/`OTP_MAX_ATTEMPTS`, `WHATSAPP_AUTH_DIR` + `WHATSAPP_PAIRING_NUMBER` (optional), `ADMIN_*`, and the still-planned `STRIPE_*`.
- Tip: create a **Neon `dev` branch** for local work so your test data stays out of the `production` branch the mobile team uses.

---

## Deployment (Railway + Neon)

- `railway.json`: build → `preDeployCommand: npx prisma migrate deploy` → `startCommand: node dist/src/main.js`.
- `nixpacks.toml`: `npm ci --include=dev` (build tools must survive production installs). `.nvmrc` = `22` + `engines.node >= 20.19` (Prisma 7 needs Node ≥20.19; Railway defaulted to 18).
- **Neon:** app runtime uses the **pooled** `DATABASE_URL` (via `@prisma/adapter-pg`); Prisma CLI/migrations use the **direct** `DIRECT_URL` (wired in `prisma.config.ts` as `DIRECT_URL ?? DATABASE_URL`).
- Railway needs a **`PORT`** variable (app binds `process.env.PORT`). **Do NOT set `NODE_ENV=production`** on Railway (it skips devDeps → build fails). Push to the connected GitHub repo → Railway auto-builds & migrates.

---

## Gotchas (important)

- **Build entry is `dist/src/main.js`** (not `dist/main.js`) because `prisma.config.ts` at the repo root lifts the tsc rootDir. `start:prod` and `railway.json` already point there.
- **The generated Prisma client uses `.js` ESM import specifiers**, which `ts-node` cannot resolve — so **`prisma/seed.ts` uses raw `pg` + argon2**, not the Prisma client. At runtime `nest build` emits relative `require`s, so the app works. Keep this in mind for any script run via ts-node.
- **`prisma migrate dev` refuses to run non-interactively when it has warnings** (enum value removal, dropping a table, new unique constraints). In an interactive terminal it prompts and works. Headless fallback: `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script --output <dir>/migration.sql`, then `prisma migrate deploy`. (Watch statement ordering when a table and enum share a name — drop the table before creating the enum.)
- **Neon SSL:** `pg` prints a non-blocking `sslmode` warning; `channel_binding=require` in the URL is harmless (pg ignores it) — remove it only if you hit a SCRAM/auth error. `sslmode=require` is required. Neon scales to zero — the first request after idle may cold-start / a migrate may need a retry.
- **Baileys is ESM-only** (`"type": "module"`) while this project is CommonJS — load it with dynamic `await import('@whiskeysockets/baileys')` (never a static import; `module: nodenext` preserves `import()`). Use **stable 6.7.x** (the 7.0.0-rc pairing was broken). `WhatsappService` starts on `onModuleInit` without blocking boot and falls back to console logging when not linked.
- Never commit `.env` (Neon URL w/ password, JWT secret, etc.) or `wa-auth/` (WhatsApp session) — both are gitignored.
