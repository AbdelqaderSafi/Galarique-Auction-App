# Real-Time Bid Updates (SSE) Implementation Plan

**Goal:** Push live bid updates, anti-snipe extensions, auction-close events, and personal (outbid/won) notifications to open auction screens over Server-Sent Events, with zero change to existing REST logic.

**Architecture:** A new isolated `realtime` module holds a `RealtimeService` that keeps one RxJS `Subject` per auction (broadcast) and one per user (personal). A `RealtimeController` exposes two `@Sse()` endpoints. Existing `BidsService` and `SettlementService` call the service post-commit, fire-and-forget, exactly like the current `sendOutbid` email. Bidding stays on REST.

**Tech Stack:** NestJS 11 (`@Sse()` from `@nestjs/common`), RxJS 7 (`Subject`/`merge`/`interval`/`map`), TypeScript. No new dependencies.

## Global Constraints

- **Prisma access:** inject `DatabaseService` (named `prisma`); never `new PrismaClient`.
- **Types/enums:** import from `generated/prisma/client`.
- **Auth is global:** every route protected by default; open with `@IsPublic(true)`, restrict with `@Roles([...])`. `req.user` is a `SafeUser` (`Omit<User,'password'>`) including `roles`.
- **Swagger:** endpoint decorators extracted to `src/swagger/<m>.swagger.ts` via `applyDecorators(...)`, tagged with a `SwaggerXTag()` helper.
- **Module shape:** `@Module({ controllers, providers, exports })`; register in `src/app.module.ts` `imports`.
- **Money:** Prisma `Decimal(12,2)`; serialize to strings via `.toFixed(2)` in payloads.
- **Broadcast is fire-and-forget post-commit:** a realtime failure must NEVER fail or alter the underlying transaction or any REST response shape.
- **Build gate:** `npx tsc --noEmit` + `npm run build` must pass clean before any live test.
- **No commit/push beyond what this plan's commit steps state; the user runs the final push.**

---

### Task 1: RealtimeService — in-memory pub/sub core

The pure, HTTP-free heart of the feature: a registry of per-auction and per-user RxJS subjects, publish methods, and stream factories with keepalive + subscriber-count cleanup. Fully unit-testable without HTTP.

**Files:**
- Create: `src/modules/realtime/realtime.types.ts`
- Create: `src/modules/realtime/realtime.service.ts`
- Test: `src/modules/realtime/realtime.service.spec.ts`

**Interfaces:**
- Consumes: nothing (self-contained).
- Produces (later tasks rely on these exact signatures):
  - Types in `realtime.types.ts`:
    - `BidEvent = { type: 'bid'; bidId: string; amount: string; bidderName: string; currentPrice: string; endTime: string | null; createdAt: string }`
    - `ClosedEvent = { type: 'closed'; status: 'ENDED' | 'UNSOLD'; currentPrice: string; winnerName: string | null }`
    - `OutbidEvent = { type: 'outbid'; auctionId: string; auctionTitle: string; newPrice: string }`
    - `WonEvent = { type: 'won'; auctionId: string; orderId: string; amountDue: string; paymentDeadline: string }`
    - `AuctionEvent = BidEvent | ClosedEvent`
    - `UserEvent = OutbidEvent | WonEvent`
  - `RealtimeService`:
    - `publishToAuction(auctionId: string, event: AuctionEvent): void`
    - `publishBid(auctionId: string, event: BidEvent): void`
    - `publishToUser(userId: string, event: UserEvent): void`
    - `auctionStream(auctionId: string): Observable<MessageEvent>`
    - `userStream(userId: string): Observable<MessageEvent>`
    - `auctionSubscriberCount(auctionId: string): number` (test/introspection helper)

- [ ] **Step 1: Write the failing test**

Create `src/modules/realtime/realtime.service.spec.ts`:

```ts
import { firstValueFrom } from 'rxjs';
import { filter, take } from 'rxjs/operators';
import { RealtimeService } from './realtime.service';
import type { BidEvent } from './realtime.types';

const sampleBid: BidEvent = {
  type: 'bid',
  bidId: 'b1',
  amount: '1500.00',
  bidderName: 'Ahmad K.',
  currentPrice: '1500.00',
  endTime: '2026-07-21T18:30:00.000Z',
  createdAt: '2026-07-21T18:29:12.000Z',
};

describe('RealtimeService', () => {
  let service: RealtimeService;
  beforeEach(() => {
    service = new RealtimeService();
  });

  it('delivers a published bid to an auction subscriber (ignoring pings)', async () => {
    const received = firstValueFrom(
      service
        .auctionStream('a1')
        .pipe(filter((m) => (m.data as { type?: string }).type === 'bid'), take(1)),
    );
    // publish on next tick so the subscription is active first
    setImmediate(() => service.publishBid('a1', sampleBid));
    const msg = await received;
    expect((msg.data as BidEvent).amount).toBe('1500.00');
    expect((msg.data as BidEvent).bidderName).toBe('Ahmad K.');
  });

  it('does not throw when publishing to an auction with no subscribers', () => {
    expect(() => service.publishBid('nobody', sampleBid)).not.toThrow();
  });

  it('cleans up the auction subject after the last subscriber unsubscribes', () => {
    const sub = service.auctionStream('a2').subscribe();
    expect(service.auctionSubscriberCount('a2')).toBe(1);
    sub.unsubscribe();
    expect(service.auctionSubscriberCount('a2')).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/realtime/realtime.service.spec.ts`
Expected: FAIL — cannot find module `./realtime.service`.

- [ ] **Step 3: Write the types**

Create `src/modules/realtime/realtime.types.ts`:

```ts
// أحداث تدفق المزاد (يشوفها كل الفاتحين للشاشة)
export type BidEvent = {
  type: 'bid';
  bidId: string;
  amount: string;
  bidderName: string;
  currentPrice: string;
  endTime: string | null;
  createdAt: string;
};

export type ClosedEvent = {
  type: 'closed';
  status: 'ENDED' | 'UNSOLD';
  currentPrice: string;
  winnerName: string | null;
};

// أحداث التدفق الشخصي (كل مستخدم يشوف تبعه فقط)
export type OutbidEvent = {
  type: 'outbid';
  auctionId: string;
  auctionTitle: string;
  newPrice: string;
};

export type WonEvent = {
  type: 'won';
  auctionId: string;
  orderId: string;
  amountDue: string;
  paymentDeadline: string;
};

export type AuctionEvent = BidEvent | ClosedEvent;
export type UserEvent = OutbidEvent | WonEvent;
```

- [ ] **Step 4: Write the service**

Create `src/modules/realtime/realtime.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { Observable, Subject, interval, merge } from 'rxjs';
import { map } from 'rxjs/operators';
import type { AuctionEvent, BidEvent, UserEvent } from './realtime.types';

const KEEPALIVE_MS = 25_000; // نبض يمنع البروكسي (Railway) من قطع الاتصال الخامل

// قناة واحدة لكل مفتاح + عدّاد مشتركين للتنظيف عند آخر انفصال
interface Channel<T> {
  subject: Subject<T>;
  count: number;
}

@Injectable()
export class RealtimeService {
  private readonly auctions = new Map<string, Channel<AuctionEvent>>();
  private readonly users = new Map<string, Channel<UserEvent>>();

  // ===== النشر (كله no-throw وآمن للاستدعاء بـ void) =====

  publishToAuction(auctionId: string, event: AuctionEvent): void {
    this.auctions.get(auctionId)?.subject.next(event);
  }

  publishBid(auctionId: string, event: BidEvent): void {
    this.publishToAuction(auctionId, event);
  }

  publishToUser(userId: string, event: UserEvent): void {
    this.users.get(userId)?.subject.next(event);
  }

  // ===== التدفقات (Observable<MessageEvent> لـ @Sse) =====

  auctionStream(auctionId: string): Observable<MessageEvent> {
    return this.stream(this.auctions, auctionId);
  }

  userStream(userId: string): Observable<MessageEvent> {
    return this.stream(this.users, userId);
  }

  auctionSubscriberCount(auctionId: string): number {
    return this.auctions.get(auctionId)?.count ?? 0;
  }

  // ===== الداخلية =====

  private stream<T>(
    map_: Map<string, Channel<T>>,
    key: string,
  ): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const channel = this.acquire(map_, key);
      const events$ = channel.subject
        .asObservable()
        .pipe(map((data) => ({ data }) as MessageEvent));
      // نبض keepalive — الكلاينت يتجاهل type:'ping'
      const ping$ = interval(KEEPALIVE_MS).pipe(
        map(() => ({ data: { type: 'ping' } }) as MessageEvent),
      );
      const sub = merge(events$, ping$).subscribe(subscriber);
      return () => {
        sub.unsubscribe();
        this.release(map_, key);
      };
    });
  }

  private acquire<T>(map_: Map<string, Channel<T>>, key: string): Channel<T> {
    let channel = map_.get(key);
    if (!channel) {
      channel = { subject: new Subject<T>(), count: 0 };
      map_.set(key, channel);
    }
    channel.count++;
    return channel;
  }

  private release<T>(map_: Map<string, Channel<T>>, key: string): void {
    const channel = map_.get(key);
    if (!channel) return;
    channel.count--;
    if (channel.count <= 0) {
      channel.subject.complete();
      map_.delete(key); // ما نخلّي تسريب ذاكرة
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/modules/realtime/realtime.service.spec.ts`
Expected: PASS (3 passing).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/modules/realtime/realtime.types.ts src/modules/realtime/realtime.service.ts src/modules/realtime/realtime.service.spec.ts
git commit -m "feat(realtime): add RealtimeService in-memory SSE pub/sub core"
```

---

### Task 2: RealtimeController + module + Swagger + registration

Expose the two SSE endpoints, validate the auction, wire Swagger, register the module. After this task the endpoints are live (they just have no publishers yet).

**Files:**
- Create: `src/modules/realtime/realtime.controller.ts`
- Create: `src/modules/realtime/realtime.module.ts`
- Create: `src/swagger/realtime.swagger.ts`
- Modify: `src/app.module.ts` (add `RealtimeModule` to imports)

**Interfaces:**
- Consumes: `RealtimeService.auctionStream(id)`, `RealtimeService.userStream(userId)` (Task 1); `PUBLIC_STATUSES` from `src/modules/auctions/auctions.service.ts`; `DatabaseService`; `SafeUser` on `req.user`.
- Produces: `RealtimeModule` (exports `RealtimeService`); routes `GET /auctions/:id/stream`, `GET /me/stream`.

- [ ] **Step 1: Write the Swagger helper**

Create `src/swagger/realtime.swagger.ts`:

```ts
import { applyDecorators } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiNotFoundResponse,
  ApiUnauthorizedResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';

export const SwaggerRealtimeTag = () => ApiTags('Realtime');

export const ApiAuctionStream = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({
      summary:
        'SSE stream of live auction events (bid, closed) — one per open auction screen',
      description:
        "Server-Sent Events. Send Authorization: Bearer <jwt>. Emits {type:'bid'|'closed'|'ping'}. On reconnect, resync via GET /auctions/:id and GET /auctions/:id/bids.",
    }),
    ApiParam({ name: 'id', description: 'Auction id' }),
    ApiOkResponse({ description: 'SSE stream opened (text/event-stream)' }),
    ApiUnauthorizedResponse({ description: 'Missing or invalid token' }),
    ApiNotFoundResponse({ description: 'Auction not found or not public' }),
  );

export const ApiMeStream = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({
      summary: 'SSE stream of my personal events (outbid, won)',
      description:
        "Server-Sent Events. Emits {type:'outbid'|'won'|'ping'} for the authenticated user.",
    }),
    ApiOkResponse({ description: 'SSE stream opened (text/event-stream)' }),
    ApiUnauthorizedResponse({ description: 'Missing or invalid token' }),
  );
```

- [ ] **Step 2: Write the controller**

Create `src/modules/realtime/realtime.controller.ts`:

```ts
import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Req,
  Sse,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { RealtimeService } from './realtime.service';
import { DatabaseService } from '../database/database.service';
import { PUBLIC_STATUSES } from '../auctions/auctions.service';
import {
  SwaggerRealtimeTag,
  ApiAuctionStream,
  ApiMeStream,
} from 'src/swagger/realtime.swagger';

@SwaggerRealtimeTag()
@Controller()
export class RealtimeController {
  constructor(
    private readonly realtime: RealtimeService,
    private readonly prisma: DatabaseService,
  ) {}

  // تدفق أحداث مزاد معيّن (محمي — أي مستخدم موثّق)
  @Sse('auctions/:id/stream')
  @ApiAuctionStream()
  async auctionStream(
    @Param('id') id: string,
  ): Promise<Observable<MessageEvent>> {
    const auction = await this.prisma.auction.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!auction || !PUBLIC_STATUSES.includes(auction.status)) {
      throw new NotFoundException('Auction not found');
    }
    return this.realtime.auctionStream(id);
  }

  // تدفق إشعاراتي الشخصية (محمي)
  @Sse('me/stream')
  @ApiMeStream()
  meStream(@Req() req: Request): Observable<MessageEvent> {
    return this.realtime.userStream(req.user!.id);
  }
}
```

Note: `@Sse()` supports an async handler that resolves to an `Observable`; Nest awaits it, so the `404` check runs before the stream opens.

- [ ] **Step 3: Write the module**

Create `src/modules/realtime/realtime.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { RealtimeController } from './realtime.controller';
import { RealtimeService } from './realtime.service';

@Module({
  controllers: [RealtimeController],
  providers: [RealtimeService],
  exports: [RealtimeService], // يستخدمه bids و orders
})
export class RealtimeModule {}
```

- [ ] **Step 4: Register in app.module.ts**

In `src/app.module.ts`, add the import near the other module imports (after the `FavoritesModule` import line):

```ts
import { RealtimeModule } from './modules/realtime/realtime.module';
```

And add `RealtimeModule` to the `imports` array (after `FavoritesModule`):

```ts
    FavoritesModule,
    RealtimeModule,
```

- [ ] **Step 5: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: both clean (no errors).

- [ ] **Step 6: Boot smoke test**

Run: `npm run dev` (in a background terminal), wait for `Nest application successfully started`, then:

```bash
# 401 without a token (stream must not open)
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/me/stream
```

Expected: `401`. Stop the dev server after checking.

- [ ] **Step 7: Commit**

```bash
git add src/modules/realtime/realtime.controller.ts src/modules/realtime/realtime.module.ts src/swagger/realtime.swagger.ts src/app.module.ts
git commit -m "feat(realtime): add SSE endpoints (auction stream + personal stream)"
```

---

### Task 3: Publish from BidsService (bid + outbid)

Wire the two auction/personal broadcasts into the successful-bid path, post-commit, alongside the existing `notifyOutbid`.

**Files:**
- Modify: `src/modules/bids/bids.service.ts` (constructor + after line ~124)
- Modify: `src/modules/bids/bids.module.ts` (import `RealtimeModule`)

**Interfaces:**
- Consumes: `RealtimeService.publishBid`, `RealtimeService.publishToUser` (Task 1). The bid path already has `bidder` (`SafeUser`, so `bidder.fullName`), `result.bid`, `result.updated`, `result.previousWinnerId`, `result.auctionTitle`.
- Produces: `bid` events on the auction channel; `outbid` events on the displaced leader's personal channel.

- [ ] **Step 1: Import RealtimeModule into BidsModule**

Edit `src/modules/bids/bids.module.ts` to:

```ts
import { Module } from '@nestjs/common';
import { BidsController } from './bids.controller';
import { BidsService } from './bids.service';
import { WalletModule } from '../wallet/wallet.module';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [WalletModule, RealtimeModule],
  controllers: [BidsController],
  providers: [BidsService],
})
export class BidsModule {}
```

- [ ] **Step 2: Inject RealtimeService into BidsService**

In `src/modules/bids/bids.service.ts`, add the import near the other module imports (after the `MailService` import, line ~10):

```ts
import { RealtimeService } from '../realtime/realtime.service';
```

Add it to the constructor (after `mail`):

```ts
  constructor(
    private readonly prisma: DatabaseService,
    private readonly wallet: WalletService,
    private readonly mail: MailService,
    private readonly realtime: RealtimeService,
  ) {}
```

- [ ] **Step 3: Publish after the transaction, before returning**

In `place()`, the block after the transaction currently reads (lines ~117-133):

```ts
    // 10) إيميل outbid بعد نجاح الـ transaction (fire-and-forget)
    if (result.previousWinnerId) {
      void this.notifyOutbid(
        result.previousWinnerId,
        result.auctionTitle,
        result.updated.currentPrice.toFixed(2),
      );
    }

    return {
      bidId: result.bid.id,
      amount: result.bid.amount.toFixed(2),
      currentPrice: result.updated.currentPrice.toFixed(2),
      endTime: result.updated.endTime,
      isHighest: true,
      depositHeld: result.depositHeld,
    };
```

Insert the realtime publishes immediately after the `notifyOutbid` block and before the `return` (so it reads):

```ts
    // 10) إيميل outbid بعد نجاح الـ transaction (fire-and-forget)
    if (result.previousWinnerId) {
      void this.notifyOutbid(
        result.previousWinnerId,
        result.auctionTitle,
        result.updated.currentPrice.toFixed(2),
      );
    }

    // 11) بث لحظي — مزايدة جديدة لكل الفاتحين شاشة المزاد + إشعار المتجاوَز
    this.realtime.publishBid(auctionId, {
      type: 'bid',
      bidId: result.bid.id,
      amount: result.bid.amount.toFixed(2),
      bidderName: bidder.fullName,
      currentPrice: result.updated.currentPrice.toFixed(2),
      endTime: result.updated.endTime
        ? result.updated.endTime.toISOString()
        : null,
      createdAt: result.bid.createdAt.toISOString(),
    });
    if (result.previousWinnerId) {
      this.realtime.publishToUser(result.previousWinnerId, {
        type: 'outbid',
        auctionId,
        auctionTitle: result.auctionTitle,
        newPrice: result.updated.currentPrice.toFixed(2),
      });
    }

    return {
      bidId: result.bid.id,
      amount: result.bid.amount.toFixed(2),
      currentPrice: result.updated.currentPrice.toFixed(2),
      endTime: result.updated.endTime,
      isHighest: true,
      depositHeld: result.depositHeld,
    };
```

(`publishBid`/`publishToUser` are synchronous no-throw `void` methods, so no `void` keyword or `await` is needed; a missing subject is a silent no-op.)

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/modules/bids/bids.service.ts src/modules/bids/bids.module.ts
git commit -m "feat(realtime): broadcast bid + outbid events from BidsService"
```

---

### Task 4: Publish from SettlementService (closed + won)

Broadcast the auction-close event to the auction channel and a `won` notification to the winner, post-commit, alongside the existing settlement emails.

**Files:**
- Modify: `src/modules/orders/settlement.service.ts` (constructor + `closeOne` after-transaction block)
- Modify: `src/modules/orders/orders.module.ts` (import `RealtimeModule`)

**Interfaces:**
- Consumes: `RealtimeService.publishToAuction`, `RealtimeService.publishToUser` (Task 1). `closeOne` already computes `outcome` with `kind`, `title`, and (for the winner) `orderId`, `buyerId`, `amountDue`, `deadline`. The auction id is the `auctionId` parameter.
- Produces: `closed` events on the auction channel; `won` events on the winner's personal channel.

- [ ] **Step 1: Import RealtimeModule into OrdersModule**

Edit `src/modules/orders/orders.module.ts` to:

```ts
import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { SettlementService } from './settlement.service';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [RealtimeModule],
  controllers: [OrdersController],
  providers: [OrdersService, SettlementService],
  exports: [SettlementService], // يستخدمه موديول scheduler
})
export class OrdersModule {}
```

- [ ] **Step 2: Inject RealtimeService into SettlementService**

In `src/modules/orders/settlement.service.ts`, add the import (after the `OrdersService` import, line ~12):

```ts
import { RealtimeService } from '../realtime/realtime.service';
```

Add it to the constructor (after `mail`):

```ts
  constructor(
    private readonly prisma: DatabaseService,
    private readonly orders: OrdersService,
    private readonly mail: MailService,
    private readonly realtime: RealtimeService,
  ) {}
```

- [ ] **Step 3: Capture winnerName inside the transaction (for the closed event)**

The `closed` event needs the winner's display name. In `closeOne`, the winner branch of the transaction currently returns (lines ~111-118):

```ts
      return {
        kind: 'ordered' as const,
        orderId: order.id,
        buyerId: auction.currentWinnerId,
        title: auction.object.title,
        amountDue: amountDue.toFixed(2),
        deadline: order.paymentDeadline,
      };
```

Add a `winnerName` lookup just before that return (inside the transaction, after the `order` is created, ~line 110):

```ts
      const winner = await tx.user.findUnique({
        where: { id: auction.currentWinnerId },
        select: { fullName: true },
      });

      return {
        kind: 'ordered' as const,
        orderId: order.id,
        buyerId: auction.currentWinnerId,
        title: auction.object.title,
        amountDue: amountDue.toFixed(2),
        deadline: order.paymentDeadline,
        currentPrice: amount.toFixed(2),
        winnerName: winner?.fullName ?? null,
      };
```

- [ ] **Step 4: Broadcast in the after-transaction block**

In `closeOne`, after `if (!outcome) return false;` (line ~121), the `unsold` branch and the `ordered` flow follow. Add the broadcasts so both close kinds emit `closed`, and the winner also gets `won`.

Replace the block from `if (outcome.kind === 'unsold') {` through the end of the winner flow (lines ~123-155) with:

```ts
    if (outcome.kind === 'unsold') {
      // بث الإغلاق لكل الفاتحين شاشة المزاد
      this.realtime.publishToAuction(auctionId, {
        type: 'closed',
        status: 'UNSOLD',
        currentPrice: '0.00',
        winnerName: null,
      });
      void this.safeMail(() =>
        this.mail.sendAuctionUnsold(
          outcome.seller.email,
          outcome.seller.fullName,
          outcome.title,
        ),
      );
      return true;
    }

    // في فائز: بث الإغلاق للمزاد + إشعار الفائز الشخصي
    this.realtime.publishToAuction(auctionId, {
      type: 'closed',
      status: 'ENDED',
      currentPrice: outcome.currentPrice,
      winnerName: outcome.winnerName,
    });
    this.realtime.publishToUser(outcome.buyerId, {
      type: 'won',
      auctionId,
      orderId: outcome.orderId,
      amountDue: outcome.amountDue,
      paymentDeadline: outcome.deadline.toISOString(),
    });

    // محاولة خصم فوري — خارج ترانزاكشن الإغلاق (payOrder يفتح ترانزاكشن خاص به).
    // نجحت → payOrder بعث إيميلات الدفع. فشلت (رصيد ناقص) → اطلب منه يدفع خلال 72 ساعة.
    try {
      await this.orders.payOrder(outcome.orderId);
    } catch {
      const buyer = await this.prisma.user.findUnique({
        where: { id: outcome.buyerId },
        select: { email: true, fullName: true },
      });
      if (buyer) {
        void this.safeMail(() =>
          this.mail.sendPaymentRequired(
            buyer.email,
            buyer.fullName,
            outcome.title,
            outcome.amountDue,
            outcome.deadline,
          ),
        );
      }
    }
    return true;
```

(The `unsold` `currentPrice` is `'0.00'` because an UNSOLD auction had no bids — `currentPrice` stayed 0.)

- [ ] **Step 5: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/modules/orders/settlement.service.ts src/modules/orders/orders.module.ts
git commit -m "feat(realtime): broadcast closed + won events from SettlementService"
```

---

### Task 5: Live end-to-end test (SSE over real HTTP)

Prove the whole thing over real HTTP: a listener on an auction stream receives a `bid` within ~1s of another user's `POST /bids`, an outbid listener receives `outbid`, and close emits `closed` + `won`. Follows the project's `.mjs` live-test convention (like `scripts/test-favorites.mjs`).

**Files:**
- Create: `scripts/seed-realtime-test.ts`
- Create: `scripts/test-realtime.mjs`

**Interfaces:**
- Consumes: running server on `http://localhost:3000`; existing REST (`POST /auth/login` or seeded JWTs, `POST /auctions/:id/bids`, `POST /scheduler/run`), and the SSE endpoints from Task 2.
- Produces: a pass/fail report.

- [ ] **Step 1: Write the seed script**

Create `scripts/seed-realtime-test.ts` modeled on `scripts/seed-favorites-test.ts` (use raw `pg` + argon2 per the seed gotcha — the generated Prisma client's `.js` ESM specifiers break under ts-node). It must create/reset and print the ids + a ready-to-use JWT (or credentials) for:
- a seller + `SellerProfile`,
- two funded buyers **A** and **B** (each with a wallet `balance >= 100` so the $50 deposit holds),
- one **LIVE** auction with `endTime` a few minutes out, `startingPrice` e.g. `100.00`, `minBidIncrement` e.g. `10.00`, `currentPrice` `0`.

Print a JSON blob to stdout: `{ auctionId, tokenA, tokenB, userAId, userBId }`. Mint the JWTs with the same `JWT_SECRET` and `{ sub, roles }` payload the app uses (`jsonwebtoken` or reuse the pattern already in the favorites seed if it mints tokens; otherwise the test logs in via `POST /auth/login`).

(Reference the exact column names and enum values from `prisma/schema.prisma` and mirror `seed-favorites-test.ts` structure — do not invent columns.)

- [ ] **Step 2: Write the live test**

Create `scripts/test-realtime.mjs`. It must:

```js
// Node 20+, run with: node scripts/test-realtime.mjs
const BASE = 'http://localhost:3000';

// Open an SSE stream and collect parsed data objects until `predicate` matches
// or `timeoutMs` elapses. Uses fetch streaming (no EventSource dependency).
async function collectSse(path, token, predicate, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const res = await fetch(BASE + path, {
    headers: { Authorization: `Bearer ${token}` },
    signal: ctrl.signal,
  });
  if (!res.ok) {
    clearTimeout(timer);
    throw new Error(`SSE ${path} -> HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // فصل رسائل SSE على السطر الفارغ المزدوج
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = raw.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const data = JSON.parse(line.slice(5).trim());
        if (data.type === 'ping') continue;
        if (predicate(data)) {
          ctrl.abort();
          clearTimeout(timer);
          return data;
        }
      }
    }
  } catch (e) {
    if (ctrl.signal.aborted) return null; // timeout
    throw e;
  }
  return null;
}

async function main() {
  // اقرأ ids/tokens اللي طبعها السيد (مرّرها كمتغيرات بيئة أو args)
  const { AUCTION_ID, TOKEN_A, TOKEN_B } = process.env;
  if (!AUCTION_ID || !TOKEN_A || !TOKEN_B) {
    throw new Error('Set AUCTION_ID, TOKEN_A, TOKEN_B env vars from the seed output');
  }
  const results = [];

  // 1) A يستمع لتدفق المزاد؛ B يزايد؛ لازم A يستقبل حدث bid خلال ~2s
  const bidPromise = collectSse(
    `/auctions/${AUCTION_ID}/stream`,
    TOKEN_A,
    (d) => d.type === 'bid',
    5000,
  );
  await new Promise((r) => setTimeout(r, 500)); // خلّي الاشتراك ينفتح
  const bidRes = await fetch(`${BASE}/auctions/${AUCTION_ID}/bids`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN_B}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ amount: 100 }),
  });
  const bidBody = await bidRes.json();
  const bidEvent = await bidPromise;
  results.push([
    'auction stream receives bid',
    bidEvent && bidEvent.type === 'bid' && bidEvent.amount === '100.00',
    JSON.stringify(bidEvent),
  ]);

  // 2) A يستمع لتدفقه الشخصي؛ B يزايد أعلى؛ لازم A يستقبل outbid
  const outbidPromise = collectSse('/me/stream', TOKEN_A, (d) => d.type === 'outbid', 5000);
  await new Promise((r) => setTimeout(r, 500));
  // أول خلّي A يتصدّر عشان ينتخطى (A يزايد 110)، بعدين B يزايد 120
  await fetch(`${BASE}/auctions/${AUCTION_ID}/bids`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: 110 }),
  });
  await fetch(`${BASE}/auctions/${AUCTION_ID}/bids`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_B}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: 120 }),
  });
  const outbidEvent = await outbidPromise;
  results.push([
    'personal stream receives outbid',
    outbidEvent && outbidEvent.type === 'outbid',
    JSON.stringify(outbidEvent),
  ]);

  // 3) الحواف: بلا توكن -> 401
  const noAuth = await fetch(`${BASE}/me/stream`);
  results.push(['no token -> 401', noAuth.status === 401, `status ${noAuth.status}`]);

  // 4) مزاد غير موجود -> 404
  const notFound = await fetch(`${BASE}/auctions/does-not-exist/stream`, {
    headers: { Authorization: `Bearer ${TOKEN_A}` },
  });
  results.push(['missing auction -> 404', notFound.status === 404, `status ${notFound.status}`]);

  // النتائج
  let pass = 0;
  for (const [name, ok, detail] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${ok ? '' : '-> ' + detail}`);
    if (ok) pass++;
  }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

(The `closed` + `won` assertions can be added as a step 3 extension: shorten the seeded auction `endTime` to ~now, open both an auction stream and the winner's `/me/stream`, call `POST /scheduler/run` with an ADMIN token, and assert a `closed` event on the auction stream and a `won` event on the winner stream. Include this only if a quick manual close is easy; otherwise verify close manually and note it.)

- [ ] **Step 3: Run the seed**

Run: `npx ts-node --transpile-only scripts/seed-realtime-test.ts`
Expected: prints `{ auctionId, tokenA, tokenB, ... }`. Copy those into env vars.

- [ ] **Step 4: Boot the server**

Run: `npm run dev` (background). Wait for `Nest application successfully started`.

- [ ] **Step 5: Run the live test**

Run (fill in from the seed output):
```bash
AUCTION_ID=<id> TOKEN_A=<a> TOKEN_B=<b> node scripts/test-realtime.mjs
```
Expected: `4/4 passed` (or more if the close extension is included). The bid event must arrive within the 5s window — proving push delivery with no polling.

- [ ] **Step 6: Commit**

```bash
git add scripts/seed-realtime-test.ts scripts/test-realtime.mjs
git commit -m "test(realtime): live SSE end-to-end test (bid, outbid, auth, 404)"
```

---

## Self-Review

**Spec coverage:**
- Live price broadcast on new bids → Task 3 (`publishBid`) + Task 5 assertion. ✓
- Anti-snipe extension reflected live → carried in the `bid` event's `endTime` (Task 1 type + Task 3 payload). ✓
- Personal outbid notification → Task 3 (`publishToUser` outbid). ✓
- Personal won/payment-required → Task 4 (`publishToUser` won). ✓
- Auction close broadcast (ENDED/UNSOLD) → Task 4 (`publishToAuction` closed). ✓
- Two SSE endpoints + AuthGuard reuse → Task 2. ✓
- `404` on non-public/missing auction → Task 2 controller + Task 5 assertion. ✓
- `401` on missing/bad token → global AuthGuard, Task 2 smoke + Task 5 assertion. ✓
- Keepalive ping → Task 1 (`interval(KEEPALIVE_MS)`). ✓
- Subscriber cleanup / no leak → Task 1 (`release` deletes empty channels) + spec test. ✓
- One-way dependency (realtime imports no feature module) → Task 2 module + Tasks 3-4 import direction. ✓
- Fire-and-forget post-commit, no logic change → Tasks 3-4 insert only after the transaction/return existing values unchanged. ✓
- No event replay; resync via REST → documented in Swagger (Task 2) and spec; nothing to build. ✓

**Placeholder scan:** No TBD/TODO. The only intentionally open item is Task 5 Step 1 (seed script), which points at the exact existing template (`seed-favorites-test.ts`) and lists every required field + output shape — an engineer can write it without further context. The `closed`/`won` live assertion is marked optional with a manual fallback.

**Type consistency:** `publishBid`/`publishToAuction`/`publishToUser`/`auctionStream`/`userStream`/`auctionSubscriberCount` names match between Task 1 (definition), Tasks 3-4 (callers), and Task 2 (controller). Event field names (`bidderName`, `currentPrice`, `endTime`, `winnerName`, `amountDue`, `paymentDeadline`) match between the `realtime.types.ts` definitions and every payload constructed in Tasks 3-4. `endTime` is `string | null` in the type and Task 3 emits `toISOString() | null` accordingly.
