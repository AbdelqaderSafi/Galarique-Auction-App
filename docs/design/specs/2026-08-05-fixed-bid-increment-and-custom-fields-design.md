# Fixed bid increment + seller-defined custom fields — design

**Date:** 2026-08-05
**Status:** built and verified (unit + integration + system)
**Module:** `auctions` (+ one additive Prisma migration)

## Problem

Two changes to the auction-creation wizard, both driven by the seller experience:

1. Letting each seller pick their own `minBidIncrement` produced inconsistent bidding rules across
   auctions with no product benefit. It should be a platform constant.
2. The fixed Details fields (era / condition / originality / dimensions) do not fit every category.
   A watch seller wants "Movement", a print seller wants "Edition number". Sellers need to add a few
   fields they name themselves.

## Decisions

### 1. `minBidIncrement` is fixed at $10

- The column **stays** on `Auction` — `BidsService` reads it to compute the bid floor, and every
  auction response carries it so the mobile app can display "next bid ≥ X".
- Its `@default` moves `50 → 10` in `prisma/schema.prisma`. **That default is the single source of
  truth**: `AuctionsService.create()` deliberately does not write the field, so there is no constant
  in the code that can drift from the schema.
- Removed from `createAuctionBodySchema` and `updateAuctionSchema`. Zod strips unknown keys, so a
  client that still sends `minBidIncrement` is silently ignored rather than erroring — this keeps the
  currently-deployed mobile build working while it migrates.
- Removing it from the update schema also blocks **admins**, not just sellers. That is intended: a
  fixed platform rule that an admin could quietly change per-auction is not fixed.

**Existing rows keep their old value of 50.** The migration only changes the default. Rewriting live
auctions' increments mid-flight would change the bidding rules under bidders who had already
committed to them. Consequence to remember: the value genuinely varies per auction, so the mobile app
must keep reading `minBidIncrement` from the response and must not hardcode 10.

### 2. Custom fields — `Object.customFields`, a JSON column

```prisma
customFields Json @default("[]")   // [{ label, value }]
```

**Why JSON and not a table.** A relational `ObjectCustomField` (mirroring `ObjectImage`) was the
alternative. Rejected because these fields are always read as part of the whole object, always
replaced wholesale, and are never queried or filtered on. JSON needs one additive migration and,
being a scalar on `Object`, is returned automatically by every existing read — `GET /auctions`,
`/auctions/:id`, `/auctions/mine`, `/auctions/seller/:sellerId`, and the admin queue — with no
changes to `OBJECT_INCLUDE`, `SELLER_AUCTIONS_INCLUDE`, or the seller-auctions mapping. The table
version would have added code and a join per read to buy queryability nothing needs.

**Not nullable.** `@default("[]")` means PostgreSQL backfills existing rows during `ADD COLUMN`, so
the field is *always* an array and never `null`. This removes a null-check from every mobile screen.

**Shape and limits** (`customFieldsSchema` in `util/auctions.validation.schema.ts`):

| Rule | Value |
| --- | --- |
| Max fields | 5 |
| `label` | trimmed, 1–30 chars |
| `value` | trimmed, 1–120 chars |
| Duplicate labels | rejected, case-insensitive |

Both `label` and `value` are plain text — no per-field type. A typed variant (number/date) was
considered and dropped: it needs type-picker UI on the mobile side for no backend gain, and the
values are only ever displayed.

**Transport.** One schema serves two encodings, because the two endpoints differ:

- `POST /auctions` is `multipart/form-data`, which cannot express nested arrays. The field arrives as
  a **JSON string**: `customFields=[{"label":"Artist","value":"Van Gogh"}]`.
- `PATCH /auctions/:id` is JSON, so it arrives as a **real array**.

`z.union([string, array]).transform(...).pipe(...)` parses the string form and raises an explicit
`customFields must be a valid JSON array` on malformed JSON, instead of Zod's default
"expected array, received string".

**Edit semantics** mirror `images` exactly — send an array to replace, `[]` to clear, omit to leave
unchanged — and are gated by the existing `EDITABLE_STATUSES` check (`DRAFT` / `PENDING_REVIEW` /
`REJECTED`), so a live auction's fields cannot change under bidders.

## Migration

`20260805120000_fixed_bid_increment_and_custom_fields`, generated with `prisma migrate diff` and
applied with `prisma migrate deploy` — **not** `migrate dev`, which wants a full reset because of the
pre-existing drift in `20260706160744_category_enum` (see the Gotchas section of `docs/PROJECT-CONTEXT.md`).

```sql
ALTER TABLE "Auction" ALTER COLUMN "minBidIncrement" SET DEFAULT 10;
ALTER TABLE "Object" ADD COLUMN     "customFields" JSONB NOT NULL DEFAULT '[]';
```

Both statements are additive and non-destructive; `ADD COLUMN` with a constant default does not
rewrite the table on PostgreSQL 11+.

## Verification

- **Unit** — `auctions.service.spec.ts` asserts `create()`/`update()` never emit `minBidIncrement`
  even when it appears in the dto, and that `customFields` reaches the `Object` write.
  `auctions.validation.schema.spec.ts` covers the JSON-string and array forms, malformed JSON, the
  count/length limits, case-insensitive duplicate labels, empty label/value, and trimming.
- **Integration** — the real-HTTP + real-Postgres lifecycle spec creates an auction via multipart and
  asserts the stored increment is 10 and the custom fields round-trip.
- **System** — `test-system-e2e.mjs` covers both endpoints against a running server with real
  ImageKit uploads: fixed increment on create, a client-sent increment being ignored, ordered storage,
  400s for duplicate labels / >5 fields / malformed JSON / an over-length label, replace-all and
  clear-with-`[]` on `PATCH`, and that an unrelated edit leaves the fields untouched.
