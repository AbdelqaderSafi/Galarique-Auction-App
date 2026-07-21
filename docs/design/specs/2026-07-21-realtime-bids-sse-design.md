# Real-Time Bid Updates (SSE) — Design

**Date:** 2026-07-21
**Module:** `realtime` (new, isolated)
**Status:** Approved — ready for implementation plan

---

## Goal

When a user has an auction screen open, they see other people's bids appear **live, without refreshing** — the current price, the new bidder's name, and the (possibly extended) end time update on their own. They also receive personal notifications (you were outbid / you won) and see the moment the auction closes. All in real time, push-based, no client polling required.

## Scope (agreed)

Chosen scope level **ج (C)** during brainstorming:
- Live **price broadcast** on new bids (currentPrice + bidder name + endTime).
- **Anti-snipe time extension** reflected live.
- **Personal notifications**: outbid, won/payment-required.
- **Auction close** moment broadcast (ENDED / UNSOLD).

**Out of scope:** live viewer/connection counters ("12 watching now"); bidding over the stream; event replay / Last-Event-ID; Redis pub/sub (deferred until load demands it — YAGNI).

## Transport decision: SSE (not WebSocket)

The broadcast is **one-directional** (server → client). Bidding stays on the existing REST `POST /auctions/:id/bids` (it needs a synchronous response, validation errors, and a DB transaction — REST does this cleanly). Given a one-way broadcast + auth already solved by the header-based `AuthGuard` + a mobile team new to WebSockets, **Server-Sent Events** deliver the identical UX with the least friction on both sides.

- **Send my bid:** `POST /auctions/:id/bids` (mobile → server) — unchanged.
- **Receive others' bids / close / personal events:** SSE streams (server → mobile).

Flutter can set custom headers on the SSE `GET` (unlike the browser `EventSource`), so the mobile client sends `Authorization: Bearer <jwt>` and the **existing `AuthGuard` works unchanged — zero new auth code**.

NestJS converts an `Observable` into an SSE stream natively via the `@Sse()` decorator; no new transport dependency is added.

---

## Architecture

New isolated module `src/modules/realtime/`:

- **`RealtimeService`**
  - `Map<auctionId, Subject<MessageEvent>>` — one broadcast channel per auction.
  - `Map<userId, Subject<MessageEvent>>` — one personal channel per user.
  - Lazily creates a `Subject` on first subscriber; **cleans it up when its last subscriber unsubscribes** (no memory leak).
  - Publish methods (all no-throw, safe to call `void`):
    - `publishBid(auctionId, payload)` — new-bid event to an auction channel.
    - `publishToAuction(auctionId, payload)` — generic auction-channel push (used for `closed`).
    - `publishToUser(userId, payload)` — personal-channel push (`outbid`, `won`).
  - Exposes `auctionStream(auctionId): Observable` and `userStream(userId): Observable` returning the subject's observable **merged with a periodic keepalive ping (~25s)**, with teardown-on-unsubscribe wired in.
- **`RealtimeController`**
  - `GET /auctions/:id/stream` (🔒 auth) — `@Sse()` auction broadcast. Validates the auction exists and is in `PUBLIC_STATUSES` (reuse `auctions.PUBLIC_STATUSES`) → `404` otherwise. Returns `realtime.auctionStream(id)`.
  - `GET /me/stream` (🔒 auth) — `@Sse()` personal stream. Returns `realtime.userStream(req.user.id)`.
- **`RealtimeModule`** — `providers: [RealtimeService]`, `exports: [RealtimeService]`. **Imports none of the other feature modules** → strictly one-way dependency; `bids` and `orders` import `RealtimeModule`, never the reverse. Registered in `app.module.ts`.

---

## Event types

### Auction stream — `GET /auctions/:id/stream`

```jsonc
// New bid (the primary event). endTime carries any anti-snipe extension,
// so a separate "extended" event is unnecessary — the client compares
// old vs new endTime if it wants an animation.
{ "type": "bid",
  "bidId": string,
  "amount": string,          // "1500.00"
  "bidderName": string,
  "currentPrice": string,    // "1500.00"
  "endTime": string,         // ISO
  "createdAt": string }      // ISO

// Auction closed
{ "type": "closed",
  "status": "ENDED" | "UNSOLD",
  "currentPrice": string,
  "winnerName": string | null }
```

### Personal stream — `GET /me/stream`

```jsonc
// You were outbid
{ "type": "outbid",
  "auctionId": string,
  "auctionTitle": string,
  "newPrice": string }

// You won → payment required
{ "type": "won",
  "auctionId": string,
  "orderId": string,
  "amountDue": string,
  "paymentDeadline": string } // ISO
```

### Keepalive (both streams)

An SSE comment ping (`: ping`) every ~25s to stop idle-connection cutoff by Railway's proxy. The client ignores it. NestJS `@Sse()` emits `MessageEvent`s; the ping is implemented as a periodic event the client is told to ignore (or an SSE comment line — implementation detail for the plan).

---

## Connection lifecycle

- **Open:** mobile opens `GET .../stream` with `Authorization: Bearer <jwt>`. `AuthGuard` verifies as on any route; bad/missing token → `401` before the stream opens.
- **Auction validation:** before streaming, confirm the auction exists and is in `PUBLIC_STATUSES` → else `404`. A `LIVE` auction is the only one receiving bids, but any public status may stream so the screen can still receive the `closed` event.
- **Disconnect:** when the client closes the screen or the network drops, the `Observable` is unsubscribed → the subscriber is removed; if an auction/user `Subject` has no subscribers left, it is deleted from its `Map`.
- **Reconnect:** the client's responsibility (re-open the `GET`). **No event replay / no Last-Event-ID by design.** On reconnect the client does a one-shot `GET /auctions/:id` + `GET /auctions/:id/bids` to resync current state, then resumes listening. The stream carries only new events; REST is always the full source of truth. This keeps the server stateless (no stored event log).
- **Limits:** no max-connection cap initially (RxJS `Subject` is lightweight). Redis pub/sub is the future scaling path if a single instance is ever outgrown — not now.

---

## Integration points (touch surface)

Exactly **three** `void` fire-and-forget calls, **all post-commit**, mirroring the existing `sendOutbid` pattern — a broadcast failure can never fail the underlying transaction, and no existing logic or response shape changes.

**1) `BidsService.place()`** — after the transaction succeeds (alongside the existing `notifyOutbid`, ~line 115):
```ts
void this.realtime.publishBid(auctionId, {
  type: 'bid', bidId, amount, bidderName, currentPrice, endTime, createdAt,
});
if (result.previousWinnerId) {
  void this.realtime.publishToUser(result.previousWinnerId, {
    type: 'outbid', auctionId, auctionTitle, newPrice,
  });
}
```
`bidderName` is already available in-transaction via the `SafeUser` bidder (`bidder.fullName`) — no extra query.

**2) `SettlementService.closeDueAuctions()`** — after the close is persisted (winner path ~line 95, UNSOLD path ~line 74):
```ts
void this.realtime.publishToAuction(auctionId, {
  type: 'closed', status, currentPrice, winnerName,
});
if (winnerId) {
  void this.realtime.publishToUser(winnerId, {
    type: 'won', auctionId, orderId, amountDue, paymentDeadline,
  });
}
```

**3) No third touch point** — `outbid` + `won` cover every personal notification in scope C.

**Dependencies:** `BidsModule` and `OrdersModule` (which owns `SettlementService`) import `RealtimeModule`. `RealtimeModule` imports neither → no circular dependency.

---

## Testing

**1) Live manual test (primary)** — an `.mjs` script in the style of `scripts/test-favorites.mjs`:
- Seed: a `LIVE` auction + seller + two funded bidders (A, B).
- A opens `GET /auctions/:id/stream` (fetch + streaming body reader, parse SSE line-by-line).
- B does `POST /bids`.
- **Assert:** A receives a `bid` event with the correct price and name **within ~1s**, with no additional request.
- A also opens `GET /me/stream`; B outbids A; **assert** A receives `outbid`.
- Trigger close (`POST /scheduler/run` or let it expire); **assert** a `closed` event arrives (+ `won` on the winner's personal stream).

**2) Edge cases:**
- No token → `401` (stream never opens).
- Bad token → `401`.
- Non-existent / non-public auction → `404`.
- Disconnect cleans up the `Subject` (verify via log — no leak).

**3) Build gate:** `tsc --noEmit` + `nest build` clean before any live test, per the per-module workflow.

**Success criterion:** a bid event reaches an open listener within ~1s with no polling, and all edge cases pass.

---

## Non-goals / accepted trade-offs

- One-directional only (bidding stays REST) — deliberate; a bidirectional WebSocket would add zero functional value here and more mobile complexity.
- No event replay — reconnect resyncs via REST; server stays stateless.
- Single-instance in-memory pub/sub — fine for a graduation-project scale; Redis is the documented future path, not built now.
