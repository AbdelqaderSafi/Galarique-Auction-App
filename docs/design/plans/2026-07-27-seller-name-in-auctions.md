# Seller Name in Seller Auctions Implementation Plan

**Goal:** Return the seller's `fullName` as `sellerName` in every item from `GET /auctions/seller/:sellerId`.

**Architecture:** Extend only the seller-auctions Prisma query to select the owner's `fullName`. Map the selected relation to a top-level `sellerName` and remove the nested owner relation so no additional user data is exposed and all other auction endpoints remain unchanged.

**Tech Stack:** NestJS 11, Prisma 7, TypeScript, Jest.

## Global Constraints

- Change only `GET /auctions/seller/:sellerId`.
- Keep pagination, ordering, status filtering, and unknown-seller behavior unchanged.
- Return `sellerName: string` on each item without exposing the complete owner record.
- Do not create a git commit unless the user explicitly requests one.

---

### Task 1: Add seller name to seller-auction items

**Files:**
- Modify: `src/modules/auctions/auctions.service.spec.ts`
- Modify: `src/modules/auctions/auctions.service.ts`
- Modify: `src/modules/auctions/dto/auctions.dto.ts`
- Modify: `src/modules/auctions/auctions.controller.ts`
- Modify: `src/swagger/auctions.swagger.ts`
- Modify: `docs/PROJECT-CONTEXT.md`

**Interfaces:**
- Consumes: `User.fullName` through `Object.owner`.
- Produces: `SellerAuctionResponseDTO = AuctionResponseDTO & { sellerName: string }`.
- Produces: `PaginatedSellerAuctionsDTO` with `items: SellerAuctionResponseDTO[]`.

- [x] **Step 1: Write the failing unit test**

Add to the existing `describe('findBySeller')` block:

```typescript
it('returns sellerName on every auction without exposing the nested owner', async () => {
  prisma.auction.findMany.mockResolvedValue([
    {
      id: 'a1',
      object: {
        id: 'object-1',
        owner: { fullName: 'Seller One' },
        images: [],
      },
    },
  ] as any);
  prisma.auction.count.mockResolvedValue(1);

  const result = await service.findBySeller('seller-1', {} as any);

  expect(result.items[0]).toEqual(
    expect.objectContaining({ id: 'a1', sellerName: 'Seller One' }),
  );
  expect((result.items[0].object as any).owner).toBeUndefined();
});
```

- [x] **Step 2: Verify the test fails for the missing field**

Run:

```bash
npx jest src/modules/auctions/auctions.service.spec.ts --runInBand
```

Expected: FAIL because `sellerName` is absent from the returned item.

- [x] **Step 3: Add precise response types**

In `src/modules/auctions/dto/auctions.dto.ts`, add:

```typescript
export type SellerAuctionResponseDTO = AuctionResponseDTO & {
  sellerName: string;
};

export type PaginatedSellerAuctionsDTO = {
  items: SellerAuctionResponseDTO[];
  total: number;
  page: number;
  limit: number;
};
```

- [x] **Step 4: Select and map the seller name**

In `src/modules/auctions/auctions.service.ts`, add an include dedicated to this endpoint:

```typescript
const SELLER_AUCTIONS_INCLUDE = {
  object: {
    include: {
      images: { orderBy: { position: 'asc' as const } },
      owner: { select: { fullName: true } },
    },
  },
} satisfies Prisma.AuctionInclude;
```

Use it in `findBySeller()`, then map:

```typescript
const mappedItems = items.map(({ object: { owner, ...object }, ...auction }) => ({
  ...auction,
  object,
  sellerName: owner.fullName,
}));

return { items: mappedItems, total, page, limit };
```

- [x] **Step 5: Apply the endpoint-specific response type**

Change `findBySeller()` and its controller handler to return `PaginatedSellerAuctionsDTO`. Update Swagger text to state that every item contains `sellerName`.

- [x] **Step 6: Verify the focused suite passes**

Run:

```bash
npx jest src/modules/auctions/auctions.service.spec.ts --runInBand
```

Expected: all auctions service tests PASS.

- [x] **Step 7: Run regression verification**

Run:

```bash
npx jest --runInBand
npx nest build
```

Expected: all unit suites PASS and the Nest build exits successfully.

- [x] **Step 8: Verify the public HTTP response**

Boot the app and call:

```text
GET /auctions/seller/:sellerId
```

Expected: HTTP 200 without authentication; every item contains `sellerName`, retains its existing `object`, and does not expose `object.owner`.

- [x] **Step 9: Update project documentation**

Update the endpoint description in `docs/PROJECT-CONTEXT.md` to mention `sellerName`, and update unit-test totals to reflect the added test.
