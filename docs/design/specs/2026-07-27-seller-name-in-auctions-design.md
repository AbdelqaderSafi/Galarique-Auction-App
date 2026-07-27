# Seller Name in Seller Auctions

## Scope

Add the seller's full name only to each auction returned by:

`GET /auctions/seller/:sellerId`

Other auction endpoints keep their existing response shapes.

## Response

Each item in the paginated `items` array gains:

```json
{
  "sellerName": "Seller One"
}
```

The value comes from the auction object's owner `User.fullName`. Existing pagination,
public-status filtering, ordering, and unknown-seller behavior remain unchanged.

## Implementation

The Prisma query selects the owner's `fullName` together with the existing object and
images. The service maps that relation into a top-level `sellerName` field and does not
expose the complete user record.

## Verification

- Unit test first: verify each returned item contains `sellerName`.
- Verify private auction statuses remain excluded.
- Run the auctions unit suite and the full unit suite.
- Exercise the public HTTP endpoint without authentication.
