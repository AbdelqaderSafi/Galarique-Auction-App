# Auctions Module — Design (2026-07-08)

The `auctions` module for GalleryQ. An **Auction** is a timed review-gated event on an
`Object`. Scope for this iteration: **create → admin review → public browse**.
Bidding, closing/settlement, and the scheduler are separate later modules.

> **Revision (2026-07-08, after Figma review):** the flow was unified to match the mobile
> create-auction wizard. `POST /auctions` now creates the **Object + Auction together in one
> request** (Category → Images → Details → Set Value → Duration → Review); the standalone
> `objects` module was **removed**. `Save as Draft` is supported (`DRAFT` → `submit` →
> `PENDING_REVIEW`, plus `DELETE` for drafts). `durationDays` presets are **1/3/7/10**.
> Set Value collects only `startingPrice` + `minBidIncrement` (no `reservePrice` input, no
> second-chance field). `Object.description` is now nullable. Everything below describing a
> separate `objectId`-based create / preset 3/5/7/10 is superseded by this note.

## Decisions (agreed in brainstorming)

- **No DRAFT stage.** Every auction is created straight into `PENDING_REVIEW`; nothing goes
  live without admin approval.
- **`estimatedValue` is removed entirely** from the `Auction` model (schema change + migration).
- **Scope** = CRUD + admin review + public browse. Closing/settlement is out of scope here.
- **Public browse is full-featured**: LIVE-only, category filter, keyword search, sort, pagination.
- **Approval/rejection emails are wired now** via the resilient `MailService`.
- **Cancel**: seller may cancel while `PENDING_REVIEW`/`REJECTED`; admin may cancel any.

## Schema change

Remove this line from `model Auction` in `prisma/schema.prisma`:

```prisma
estimatedValue  Decimal? @db.Decimal(12, 2) // تقديري خاص (لا يراه المشتري)
```

Migration name: `auctions_remove_estimated_value`. If `prisma migrate dev` refuses to run
non-interactively on the column drop (documented docs/PROJECT-CONTEXT.md gotcha), fall back to a hand-written
`ALTER TABLE "Auction" DROP COLUMN "estimatedValue";` migration + `prisma migrate deploy`, then
`prisma generate`. Also prune `estimatedValue` mentions from `docs/PROJECT-CONTEXT.md`.

## Files (mirror the `objects` module)

```
src/modules/auctions/
  auctions.module.ts
  auctions.controller.ts
  auctions.service.ts
  dto/auctions.dto.ts
  util/auctions.validation.schema.ts
src/swagger/auctions.swagger.ts
```

Also: register `AuctionsModule` in `src/app.module.ts`; add two methods to `MailService`;
edit `prisma/schema.prisma`.

## Endpoints

### Seller (`@Roles([SELLER])`)

- **`POST /auctions`** — create from an AVAILABLE object the seller owns.
  Body `{ objectId, startingPrice, reservePrice?, minBidIncrement?, durationDays }`.
  In a **transaction**: create Auction (`PENDING_REVIEW`, `currentPrice=0`, no start/end time)
  and set `Object.status = IN_AUCTION`. Validates ownership + `status === AVAILABLE`.
- **`GET /auctions/mine`** — the seller's own auctions (all statuses), with object + images.
- **`PATCH /auctions/:id`** — edit `startingPrice`/`reservePrice`/`minBidIncrement`/`durationDays`
  while `PENDING_REVIEW` or `REJECTED` only. Owner only. Editing a `REJECTED` auction clears
  `rejectionReason`/review fields and resets it to `PENDING_REVIEW` (fix-and-resubmit).
- **`POST /auctions/:id/cancel`** — seller may cancel while `PENDING_REVIEW`/`REJECTED`.
  Auction → `CANCELLED`, object → `AVAILABLE`.

### Public (`@IsPublic(true)`)

- **`GET /auctions`** — browse LIVE auctions.
  Query `{ category?, q?, sort=endingSoon|newest|priceLow|priceHigh, page=1, limit=20 }`.
  Returns `{ items, total, page, limit }`; each item includes object + images.
- **`GET /auctions/:id`** — public detail. Only for `LIVE/ENDED/SOLD/UNSOLD` (otherwise 404 so
  drafts/pending never leak). Increments `viewsCount`. Includes object, images, and `bidCount`.

### Admin (`@Roles([ADMIN])`)

- **`GET /auctions/admin/pending`** — the review queue (`PENDING_REVIEW`), oldest first.
- **`POST /auctions/:id/approve`** — from `PENDING_REVIEW` only → `LIVE`, `startTime = now`,
  `endTime = now + durationDays·24h`, set `reviewedById`/`reviewedAt`. Object stays `IN_AUCTION`.
  Emails the seller.
- **`POST /auctions/:id/reject`** — Body `{ reason }`. From `PENDING_REVIEW` only → `REJECTED`
  + `rejectionReason`, `reviewedById`/`reviewedAt`. Object stays `IN_AUCTION` (seller fixes &
  resubmits or cancels). Emails the seller.

## Rules & decisions

- **`durationDays ∈ {3,5,7,10}`** (preset, enforced in Zod). `startTime`/`endTime` stay null
  until approval.
- **`currentPrice` stays 0 until the first bid** — deliberately not seeded to `startingPrice`,
  so the future bids module owns the opening-bid floor. Responses expose both `startingPrice`
  and `currentPrice`.
- **`reservePrice ≥ startingPrice`** when provided (Zod refine). `minBidIncrement` defaults to 50
  (schema default). `antiSnipeSeconds`/`extendBySeconds` keep schema defaults.
- **Money** passed as `number` from Zod → Prisma coerces to `Decimal(12,2)` (same as `objects`
  height/width fields).
- **One active auction per object** — enforced by the `AVAILABLE`→`IN_AUCTION` gate on create;
  the object only returns to `AVAILABLE` on cancel.

## Validation (Zod) & DTOs

- `createAuctionSchema` — `objectId` uuid; `startingPrice` positive; `reservePrice` positive
  optional; `minBidIncrement` positive optional; `durationDays` one of 3/5/7/10;
  refine `reservePrice ≥ startingPrice`.
- `updateAuctionSchema` — create shape minus `objectId`, all optional (still refined).
- `rejectAuctionSchema` — `reason` string 3–500.
- `browseAuctionsQuerySchema` — `category?` enum, `q?` string, `sort?` enum, `page`/`limit`
  coerced positive ints (limit capped, e.g. ≤ 50).
- DTOs: request **classes** with `@ApiProperty`; response `type`s
  (`AuctionResponseDTO`, `PaginatedAuctionsDTO`).

## Emails (Brevo, resilient)

Add to `MailService`: `sendAuctionApproved(to, fullName, title)` and
`sendAuctionRejected(to, fullName, title, reason)` — same resilient pattern (log if no key,
never fail the request). Wired into `approve`/`reject`; the seller address comes from
`object.owner`.

## Testing

Follow the docs/PROJECT-CONTEXT.md per-module workflow: `tsc` + `nest build` → boot → exercise **every**
endpoint (happy path + auth/role/validation failures). A throwaway test script (raw `pg` +
a JWT minted with `JWT_SECRET`, the `seed.ts` pattern) sets up a SELLER user + an AVAILABLE
object; admin routes use the seeded admin. Assert status codes for each case; tear down the
test data afterward. Only commit once the full matrix passes.
