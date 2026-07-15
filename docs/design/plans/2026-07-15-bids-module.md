# Bids Module Implementation Plan

**Goal:** Let any authenticated user place bids on a LIVE auction, holding a $50 deposit on the current leader and releasing it the moment they're outbid, with anti-snipe extension and an outbid email.

**Architecture:** A standalone `bids` NestJS module (service + controller + swagger + DTO + Zod). The core `POST /auctions/:id/bids` runs inside a Postgres interactive transaction that row-locks the auction (`SELECT ... FOR UPDATE`) for concurrency safety. Deposit hold/release lives in `WalletService` (two new helpers that take the transaction client) so wallet tables are only touched by the wallet module.

**Tech Stack:** NestJS 11, Prisma 7 (custom client at `generated/prisma`), PostgreSQL (Neon), TypeScript, Zod validation, Swagger via `applyDecorators`.

## Global Constraints

- **Prisma access:** inject `DatabaseService` (conventionally `prisma`); never `new PrismaClient`.
- **Types/enums:** import from `generated/prisma/client` (e.g. `import { AuctionStatus, Prisma } from 'generated/prisma/client'`).
- **Money:** always `Prisma.Decimal`, `Decimal(12,2)`, USD only. Serialize to responses as `.toFixed(2)` strings.
- **Deposit:** flat **$50**, held on the current highest bidder only; released immediately on outbid. One `AuctionDeposit` row per `(auctionId, userId)` (`@@unique`), toggled `HELD ↔ RELEASED`.
- **Auth is global:** every route protected by default. Public routes use `@IsPublic(true)`. `req.user!` is a `SafeUser` (no password, includes `roles`).
- **Validation:** Zod schema in `util/`, applied with `ZodValidationPipe` on the body.
- **Swagger:** endpoint decorators extracted into `src/swagger/bids.swagger.ts`.
- **No new migration:** `Bid` and `AuctionDeposit` models already exist in `prisma/schema.prisma`. Do NOT run `prisma migrate` (avoids the known `20260706160744_category_enum` drift).
- **Testing workflow (project convention, not jest):** this repo verifies modules with **live HTTP endpoint testing** via the `test-endpoints` skill — there are no `.spec.ts` unit tests for feature modules. Each build task's fast gate is a clean TypeScript compile (`npx tsc --noEmit`); the final task is full live endpoint testing.
- **Commits:** the user commits/pushes. Do NOT `git commit` unless the user explicitly asks. Each task below ends at a verified, committable state; leave the actual commit to the user.

**Spec:** `docs/design/specs/2026-07-15-bids-module-design.md`

---

### Task 1: WalletService deposit helpers (`holdBidDeposit` + `releaseBidDeposit`)

**Files:**
- Modify: `src/modules/wallet/wallet.service.ts`
- (Already exported: `WalletModule` exports `WalletService`.)

**Interfaces:**
- Consumes: `DatabaseService` (already injected), `Prisma` from `generated/prisma/client`.
- Produces (used by Task 4):
  - `holdBidDeposit(tx: Prisma.TransactionClient, userId: string, auctionId: string): Promise<boolean>` — returns `true` if a deposit was newly held, `false` if the user already had a HELD deposit. Throws `BadRequestException` on insufficient balance.
  - `releaseBidDeposit(tx: Prisma.TransactionClient, userId: string, auctionId: string): Promise<void>` — no-op if the deposit isn't currently HELD.

- [ ] **Step 1: Add a deposit-amount constant near the top of the class body**

In `src/modules/wallet/wallet.service.ts`, add above the constructor (inside the class):

```ts
  // العربون الثابت لكل مزايدة أولى بمزاد
  private readonly DEPOSIT_AMOUNT = new Prisma.Decimal(50);
```

- [ ] **Step 2: Add the two helpers in a new "Bid deposits" section**

Add these methods to the `WalletService` class (e.g. after `requestWithdrawal`, before the `// ===== Helpers =====` block). `Prisma`, `WalletTxnType`, `BadRequestException` are already imported.

```ts
  // ===== Bid deposits (called by the bids module inside its transaction) =====

  // يحجز عربون $50 للمزايد الحالي (idempotent: لا يحجز مرتين لنفس المزاد)
  // يرجّع true لو انحجز الآن، false لو كان محجوزاً أصلاً. يرمي 400 لو الرصيد أقل من 50.
  async holdBidDeposit(
    tx: Prisma.TransactionClient,
    userId: string,
    auctionId: string,
  ): Promise<boolean> {
    const wallet = await tx.wallet.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });

    const existing = await tx.auctionDeposit.findUnique({
      where: { auctionId_userId: { auctionId, userId } },
    });
    if (existing?.status === 'HELD') {
      return false; // محجوز أصلاً — لا نحجز ثانية
    }

    if (wallet.balance.lessThan(this.DEPOSIT_AMOUNT)) {
      throw new BadRequestException(
        `Insufficient balance for the $50 bid deposit. Needed: $${this.DEPOSIT_AMOUNT.toFixed(
          2,
        )}, available: $${wallet.balance.toFixed(2)}. Top up your wallet.`,
      );
    }

    await tx.wallet.update({
      where: { id: wallet.id },
      data: {
        balance: { decrement: this.DEPOSIT_AMOUNT },
        lockedBalance: { increment: this.DEPOSIT_AMOUNT },
      },
    });

    // صف واحد لكل (مزاد، مستخدم) — نبدّل RELEASED→HELD أو ننشئه
    await tx.auctionDeposit.upsert({
      where: { auctionId_userId: { auctionId, userId } },
      create: { auctionId, userId, status: 'HELD' },
      update: { status: 'HELD' },
    });

    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: WalletTxnType.DEPOSIT_HOLD,
        amount: this.DEPOSIT_AMOUNT,
        refId: auctionId,
        note: 'Bid deposit hold ($50)',
      },
    });

    return true;
  }

  // يُرجِع عربون المزايد المُتجاوَز فوراً (locked → balance). no-op لو مش HELD.
  async releaseBidDeposit(
    tx: Prisma.TransactionClient,
    userId: string,
    auctionId: string,
  ): Promise<void> {
    const deposit = await tx.auctionDeposit.findUnique({
      where: { auctionId_userId: { auctionId, userId } },
    });
    if (!deposit || deposit.status !== 'HELD') {
      return;
    }

    const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId } });

    await tx.wallet.update({
      where: { id: wallet.id },
      data: {
        lockedBalance: { decrement: this.DEPOSIT_AMOUNT },
        balance: { increment: this.DEPOSIT_AMOUNT },
      },
    });

    await tx.auctionDeposit.update({
      where: { auctionId_userId: { auctionId, userId } },
      data: { status: 'RELEASED' },
    });

    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: WalletTxnType.DEPOSIT_RELEASE,
        amount: this.DEPOSIT_AMOUNT,
        refId: auctionId,
        note: 'Bid deposit released (outbid)',
      },
    });
  }
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors. (If `AuctionDeposit.status` string literals `'HELD'`/`'RELEASED'` error, import and use the `DepositStatus` enum from `generated/prisma/client` instead — but Prisma accepts the string literal for enum columns, so this should pass.)

---

### Task 2: `MailService.sendOutbid`

**Files:**
- Modify: `src/modules/mail/mail.service.ts`

**Interfaces:**
- Produces (used by Task 4): `sendOutbid(to: string, fullName: string, auctionTitle: string, newPrice: string): Promise<void>` — `newPrice` is a preformatted amount string (e.g. `"250.00"`).

- [ ] **Step 1: Add the `sendOutbid` public method**

In `src/modules/mail/mail.service.ts`, add after `sendAuctionRejected` (before the private `send`):

```ts
  async sendOutbid(
    to: string,
    fullName: string,
    auctionTitle: string,
    newPrice: string,
  ): Promise<void> {
    const subject = `You've been outbid on ${auctionTitle}`;
    const html = this.buildOutbidHtml(fullName, auctionTitle, newPrice);
    const text =
      `Hi ${fullName},\n\n` +
      `Someone placed a higher bid on "${auctionTitle}".\n` +
      `The current bid is now $${newPrice}.\n\n` +
      `Place a higher bid in the app to take the lead again.\n\n` +
      `Bid Smart. Win Big.`;

    await this.send({ to, subject, html, text });
  }
```

- [ ] **Step 2: Add the matching private HTML builder**

Add near the other `build...Html` private methods:

```ts
  private buildOutbidHtml(
    fullName: string,
    auctionTitle: string,
    newPrice: string,
  ): string {
    return `
  <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
    <h2 style="margin: 0 0 16px;">Bid Smart. Win Big.</h2>
    <p>Hi ${fullName},</p>
    <p>You've been outbid on <strong>${auctionTitle}</strong>.</p>
    <p style="background: #fff7ed; border-radius: 8px; padding: 12px 16px; color: #9a3412;">
      The current bid is now <strong>$${newPrice}</strong>.
    </p>
    <p style="font-size: 13px; color: #6b7280;">
      Place a higher bid in the app to take the lead again.
    </p>
  </div>`;
  }
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

---

### Task 3: Bids DTOs + Zod validation schema

**Files:**
- Create: `src/modules/bids/dto/bids.dto.ts`
- Create: `src/modules/bids/util/bids.validation.schema.ts`

**Interfaces:**
- Produces (used by Tasks 4, 5, 6): `PlaceBidDto`, response types `PlaceBidResponse`, `AuctionBidsResponse`, `MyBidsResponse`, item types `AuctionBidItem`, `MyBidItem`; `placeBidSchema`.

- [ ] **Step 1: Create the validation schema**

Create `src/modules/bids/util/bids.validation.schema.ts`:

```ts
import { z } from 'zod';

// مبلغ المزايدة: رقم موجب بحد أقصى خانتين عشريتين (USD)
export const placeBidSchema = z.object({
  amount: z
    .number({ message: 'amount must be a number' })
    .positive('amount must be greater than 0')
    .multipleOf(0.01, 'amount supports at most 2 decimal places'),
});
```

- [ ] **Step 2: Create the DTO + response types**

Create `src/modules/bids/dto/bids.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import type { AuctionStatus } from 'generated/prisma/client';

// ===== Request DTO =====

export class PlaceBidDto {
  @ApiProperty({
    example: 250,
    description:
      'Bid amount in USD (> 0, up to 2 decimals). Must be ≥ current price + min increment, or ≥ starting price for the first bid.',
  })
  amount!: number;
}

// ===== Response shapes =====

export type PlaceBidResponse = {
  bidId: string;
  amount: string; // "250.00"
  currentPrice: string;
  endTime: Date | null; // reflects any anti-snipe extension
  isHighest: true;
  depositHeld: boolean; // true if a $50 deposit was newly held on this call
};

export type AuctionBidItem = {
  id: string;
  amount: string;
  bidderName: string; // full name (no anonymization)
  createdAt: Date;
};

export type AuctionBidsResponse = {
  items: AuctionBidItem[];
  page: number;
  limit: number;
  total: number;
};

export type MyBidItem = {
  bidId: string;
  auctionId: string;
  title: string;
  mainImage: string;
  status: AuctionStatus;
  currentPrice: string;
  myAmount: string;
  isWinning: boolean;
  createdAt: Date;
};

export type MyBidsResponse = {
  items: MyBidItem[];
  page: number;
  limit: number;
  total: number;
};
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

---

### Task 4: BidsService (place + read endpoints)

**Files:**
- Create: `src/modules/bids/bids.service.ts`

**Interfaces:**
- Consumes: `DatabaseService`, `WalletService.holdBidDeposit` / `releaseBidDeposit` (Task 1), `MailService.sendOutbid` (Task 2), DTO types (Task 3).
- Produces (used by Task 6):
  - `place(auctionId: string, bidder: SafeUser, amount: number): Promise<PlaceBidResponse>`
  - `getAuctionBids(auctionId: string, page?: number, limit?: number): Promise<AuctionBidsResponse>`
  - `getMyBids(userId: string, page?: number, limit?: number): Promise<MyBidsResponse>`

- [ ] **Step 1: Create the service with `place()` (the core)**

Create `src/modules/bids/bids.service.ts`:

```ts
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuctionStatus, Prisma } from 'generated/prisma/client';
import { DatabaseService } from '../database/database.service';
import { WalletService } from '../wallet/wallet.service';
import { MailService } from '../mail/mail.service';
import type { SafeUser } from 'src/types/declartion-mergin';
import type {
  AuctionBidsResponse,
  MyBidsResponse,
  PlaceBidResponse,
} from './dto/bids.dto';

// الحالات التي يجوز عرض مزايداتها للعامة (نفس منطق auctions)
const PUBLIC_STATUSES: AuctionStatus[] = [
  AuctionStatus.LIVE,
  AuctionStatus.ENDED,
  AuctionStatus.SOLD,
  AuctionStatus.UNSOLD,
];

@Injectable()
export class BidsService {
  constructor(
    private readonly prisma: DatabaseService,
    private readonly wallet: WalletService,
    private readonly mail: MailService,
  ) {}

  // وضع مزايدة — كل الخطوات داخل transaction واحد مع قفل صف المزاد
  async place(
    auctionId: string,
    bidder: SafeUser,
    amount: number,
  ): Promise<PlaceBidResponse> {
    const amountDec = new Prisma.Decimal(amount.toFixed(2));

    const result = await this.prisma.$transaction(async (tx) => {
      // 1) قفل صف المزاد — أي مزايدة متزامنة تنتظر
      await tx.$queryRaw`SELECT id FROM "Auction" WHERE id = ${auctionId} FOR UPDATE`;

      const auction = await tx.auction.findUnique({
        where: { id: auctionId },
        include: { object: { select: { ownerId: true, title: true } } },
      });
      if (!auction) throw new NotFoundException('Auction not found');

      // 2) لازم LIVE وضمن الوقت (نرفض حتى لو السكدولر ما أغلق بعد)
      const now = new Date();
      if (
        auction.status !== AuctionStatus.LIVE ||
        !auction.endTime ||
        auction.endTime <= now
      ) {
        throw new BadRequestException('Auction is not live');
      }

      // 3) البائع لا يزايد على قطعته
      if (auction.object.ownerId === bidder.id) {
        throw new ForbiddenException('You cannot bid on your own auction');
      }

      // 4) المتصدّر الحالي لا يزايد على نفسه
      if (auction.currentWinnerId === bidder.id) {
        throw new BadRequestException("You're already the highest bidder");
      }

      // 5) أرضية السعر
      const isFirstBid = auction.currentWinnerId === null;
      const floor = isFirstBid
        ? auction.startingPrice
        : auction.currentPrice.add(auction.minBidIncrement);
      if (amountDec.lessThan(floor)) {
        throw new BadRequestException(`Minimum bid is $${floor.toFixed(2)}`);
      }

      // 6) احجز عربون المزايد الحالي ($50)
      const depositHeld = await this.wallet.holdBidDeposit(
        tx,
        bidder.id,
        auctionId,
      );

      // 7) سجّل المزايدة
      const previousWinnerId = auction.currentWinnerId;
      const bid = await tx.bid.create({
        data: { auctionId, bidderId: bidder.id, amount: amountDec },
      });

      // 8) anti-snipe: مدّد endTime لو المزايدة بآخر antiSnipeSeconds
      const remainingMs = auction.endTime.getTime() - now.getTime();
      const extend = remainingMs <= auction.antiSnipeSeconds * 1000;
      const newEndTime = extend
        ? new Date(auction.endTime.getTime() + auction.extendBySeconds * 1000)
        : auction.endTime;

      const updated = await tx.auction.update({
        where: { id: auctionId },
        data: {
          currentPrice: amountDec,
          currentWinnerId: bidder.id,
          ...(extend && { endTime: newEndTime }),
        },
      });

      // 9) أرجِع عربون المُتجاوَز فوراً
      if (previousWinnerId) {
        await this.wallet.releaseBidDeposit(tx, previousWinnerId, auctionId);
      }

      return {
        bid,
        updated,
        previousWinnerId,
        depositHeld,
        auctionTitle: auction.object.title,
      };
    });

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
  }

  // إشعار المتصدّر السابق — لا يُفشِل المزايدة إن فشل البريد
  private async notifyOutbid(
    userId: string,
    auctionTitle: string,
    newPrice: string,
  ): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, fullName: true },
      });
      if (user) {
        await this.mail.sendOutbid(
          user.email,
          user.fullName,
          auctionTitle,
          newPrice,
        );
      }
    } catch {
      // تجاهل — البريد لا يُفشِل المزايدة
    }
  }
```

- [ ] **Step 2: Add the two read methods and close the class**

Append inside the class (after `notifyOutbid`):

```ts
  // سجل مزايدات المزاد (عام) — الأعلى أولاً، مع اسم المزايد كامل
  async getAuctionBids(
    auctionId: string,
    page = 1,
    limit = 20,
  ): Promise<AuctionBidsResponse> {
    const safePage = page > 0 ? page : 1;
    const safeLimit = limit > 0 && limit <= 100 ? limit : 20;

    const auction = await this.prisma.auction.findUnique({
      where: { id: auctionId },
      select: { status: true },
    });
    if (!auction || !PUBLIC_STATUSES.includes(auction.status)) {
      throw new NotFoundException('Auction not found');
    }

    const where = { auctionId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.bid.findMany({
        where,
        orderBy: { amount: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
        include: { bidder: { select: { fullName: true } } },
      }),
      this.prisma.bid.count({ where }),
    ]);

    return {
      items: rows.map((b) => ({
        id: b.id,
        amount: b.amount.toFixed(2),
        bidderName: b.bidder.fullName,
        createdAt: b.createdAt,
      })),
      page: safePage,
      limit: safeLimit,
      total,
    };
  }

  // مزايداتي عبر كل المزادات (محمي) — الأحدث أولاً
  async getMyBids(
    userId: string,
    page = 1,
    limit = 20,
  ): Promise<MyBidsResponse> {
    const safePage = page > 0 ? page : 1;
    const safeLimit = limit > 0 && limit <= 100 ? limit : 20;

    const where = { bidderId: userId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.bid.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
        include: {
          auction: {
            select: {
              id: true,
              status: true,
              currentPrice: true,
              currentWinnerId: true,
              object: { select: { title: true, mainImage: true } },
            },
          },
        },
      }),
      this.prisma.bid.count({ where }),
    ]);

    return {
      items: rows.map((b) => ({
        bidId: b.id,
        auctionId: b.auction.id,
        title: b.auction.object.title,
        mainImage: b.auction.object.mainImage,
        status: b.auction.status,
        currentPrice: b.auction.currentPrice.toFixed(2),
        myAmount: b.amount.toFixed(2),
        isWinning: b.auction.currentWinnerId === userId,
        createdAt: b.createdAt,
      })),
      page: safePage,
      limit: safeLimit,
      total,
    };
  }
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors. (`bidder`, `auction` relations exist on the `Bid` model; `object` include on `Auction` matches `OBJECT_INCLUDE` usage in auctions.)

---

### Task 5: Bids Swagger decorators

**Files:**
- Create: `src/swagger/bids.swagger.ts`

**Interfaces:**
- Consumes: `PlaceBidDto` (Task 3).
- Produces (used by Task 6): `SwaggerBidsTag`, `ApiPlaceBid`, `ApiAuctionBids`, `ApiMyBids`.

- [ ] **Step 1: Create the swagger file**

Create `src/swagger/bids.swagger.ts`:

```ts
import { applyDecorators } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiUnauthorizedResponse,
  ApiBearerAuth,
  ApiBody,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { PlaceBidDto } from '../modules/bids/dto/bids.dto';

export const SwaggerBidsTag = () => ApiTags('Bids');

export const ApiPlaceBid = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({
      summary:
        'Place a bid on a LIVE auction (holds a $50 deposit; releases the previous leader’s)',
    }),
    ApiParam({ name: 'id', description: 'Auction id' }),
    ApiBody({ type: PlaceBidDto }),
    ApiCreatedResponse({
      description:
        '{ bidId, amount, currentPrice, endTime, isHighest, depositHeld }',
    }),
    ApiBadRequestResponse({
      description:
        'Not live / below minimum / already highest / insufficient $50 deposit balance',
    }),
    ApiForbiddenResponse({ description: 'You cannot bid on your own auction' }),
    ApiNotFoundResponse({ description: 'Auction not found' }),
    ApiUnauthorizedResponse({ description: 'Login required' }),
  );

export const ApiAuctionBids = () =>
  applyDecorators(
    ApiOperation({ summary: 'Public bid history for an auction (highest first)' }),
    ApiParam({ name: 'id', description: 'Auction id' }),
    ApiQuery({ name: 'page', required: false, example: 1 }),
    ApiQuery({ name: 'limit', required: false, example: 20 }),
    ApiOkResponse({ description: '{ items, page, limit, total }' }),
    ApiNotFoundResponse({ description: 'Auction not found' }),
  );

export const ApiMyBids = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'List my bids across all auctions (newest first)' }),
    ApiQuery({ name: 'page', required: false, example: 1 }),
    ApiQuery({ name: 'limit', required: false, example: 20 }),
    ApiOkResponse({ description: '{ items, page, limit, total }' }),
    ApiUnauthorizedResponse({ description: 'Login required' }),
  );
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

---

### Task 6: BidsController + BidsModule + register in AppModule

**Files:**
- Create: `src/modules/bids/bids.controller.ts`
- Create: `src/modules/bids/bids.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `BidsService` (Task 4), swagger decorators (Task 5), DTO + schema (Task 3), `WalletModule` (for the `WalletService` provider).

- [ ] **Step 1: Create the controller**

Routes use **full paths** (no controller-level prefix) so the two auction-scoped routes and `/bids/mine` coexist without prefix conflicts. `GET /auctions/:id/bids` has an extra path segment, so it never collides with the auctions module's `GET /auctions/:id`.

Create `src/modules/bids/bids.controller.ts`:

```ts
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UsePipes,
} from '@nestjs/common';
import type { Request } from 'express';
import { IsPublic } from 'src/decorators/public.decorator';
import { ZodValidationPipe } from 'src/pipes/zod.validation.pipe';
import { BidsService } from './bids.service';
import { PlaceBidDto } from './dto/bids.dto';
import type {
  AuctionBidsResponse,
  MyBidsResponse,
  PlaceBidResponse,
} from './dto/bids.dto';
import { placeBidSchema } from './util/bids.validation.schema';
import {
  SwaggerBidsTag,
  ApiPlaceBid,
  ApiAuctionBids,
  ApiMyBids,
} from 'src/swagger/bids.swagger';

@SwaggerBidsTag()
@Controller()
export class BidsController {
  constructor(private readonly bidsService: BidsService) {}

  // وضع مزايدة (محمي — أي مستخدم موثّق)
  @Post('auctions/:id/bids')
  @HttpCode(201)
  @ApiPlaceBid()
  @UsePipes(new ZodValidationPipe(placeBidSchema))
  place(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: PlaceBidDto,
  ): Promise<PlaceBidResponse> {
    return this.bidsService.place(id, req.user!, dto.amount);
  }

  // سجل مزايدات المزاد (عام)
  @Get('auctions/:id/bids')
  @IsPublic(true)
  @ApiAuctionBids()
  auctionBids(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<AuctionBidsResponse> {
    return this.bidsService.getAuctionBids(
      id,
      page ? Number(page) : undefined,
      limit ? Number(limit) : undefined,
    );
  }

  // مزايداتي (محمي)
  @Get('bids/mine')
  @ApiMyBids()
  myBids(
    @Req() req: Request,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<MyBidsResponse> {
    return this.bidsService.getMyBids(
      req.user!.id,
      page ? Number(page) : undefined,
      limit ? Number(limit) : undefined,
    );
  }
}
```

- [ ] **Step 2: Create the module**

`WalletModule` exports `WalletService`; `MailService` and `DatabaseService` are `@Global`, so only `WalletModule` needs importing.

Create `src/modules/bids/bids.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { BidsController } from './bids.controller';
import { BidsService } from './bids.service';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [WalletModule],
  controllers: [BidsController],
  providers: [BidsService],
})
export class BidsModule {}
```

- [ ] **Step 3: Register `BidsModule` in `AppModule`**

In `src/app.module.ts`, add the import at the top with the other module imports:

```ts
import { BidsModule } from './modules/bids/bids.module';
```

and add `BidsModule` to the `imports` array, after `WalletModule`:

```ts
    AuctionsModule,
    WalletModule,
    BidsModule,
```

- [ ] **Step 4: Verify it compiles and builds**

Run: `npx tsc --noEmit && npm run build`
Expected: both succeed with no errors.

---

### Task 7: Live endpoint testing (project verification gate)

**Files:** none (verification only). Uses the `test-endpoints` skill.

**Prerequisite data:** a LIVE auction (approve one via the admin flow), a seller account (its owner), and at least two buyer accounts each with wallet `balance ≥ $50` (top up via the wallet flow, or seed balances directly in the DB for the test).

- [ ] **Step 1: Boot the app and run the `test-endpoints` skill over the bids endpoints**

Invoke the `test-endpoints` skill. Exercise every endpoint and assertion below with real HTTP calls, then report a pass/fail table.

- [ ] **Step 2: Confirm each scenario passes**

1. **Happy path (first bid):** buyer A bids `≥ startingPrice` on a LIVE auction → `201`, `depositHeld: true`. Verify `GET /wallet` for A: `balance −50`, `lockedBalance +50`; `GET /wallet/transactions` shows a `DEPOSIT_HOLD`. Auction `currentPrice`/`currentWinner` updated (`GET /auctions/:id`).
2. **Outbid + release:** buyer B bids `≥ currentPrice + minBidIncrement` → `201`. B: `balance −50`, `lockedBalance +50`, `DEPOSIT_HOLD`. **A: `lockedBalance −50`, `balance +50`, a `DEPOSIT_RELEASE` txn.** An outbid email to A appears in the app logs (or is sent, if `BREVO_API_KEY` is set).
3. **Retake the lead:** A outbids B again → A holds again (no duplicate `AuctionDeposit` row — one row per bidder, now HELD), B is released. Only the current winner holds a deposit.
4. **Rejections:**
   - Below the floor → `400` "Minimum bid is $X.XX".
   - Current winner re-bidding → `400` "You're already the highest bidder".
   - Owner bidding on their own auction → `403`.
   - Buyer with `balance < $50` (fresh account, no top-up) → `400` with needed/available.
   - Bidding on a non-LIVE auction (DRAFT/PENDING/ENDED/CANCELLED) → `400` "Auction is not live".
   - No token (guest) → `401`.
   - `amount` with 3+ decimals or ≤ 0 → `400` (Zod).
5. **Reads:**
   - `GET /auctions/:id/bids` (no token) → `200`, ordered highest-first, full bidder names.
   - `GET /auctions/:id/bids` for a DRAFT/non-public auction → `404`.
   - `GET /bids/mine` with a token → `200` with `isWinning` flags; without a token → `401`.
6. **(Optional) Concurrency:** fire two bids nearly simultaneously on the same auction → exactly one succeeds; the other is rejected against the updated price (no two winners, no double `currentPrice` skip).

- [ ] **Step 3: Report results and hand off**

Produce the pass/fail table. If all green, tell the user the module is verified and ready — the user decides on the commit (do not commit automatically).

---

## Notes for the implementer

- **Do not** run `prisma migrate` — the schema already has `Bid`/`AuctionDeposit`; a migrate attempt hits the known `category_enum` drift and wants a reset (never reset — it would wipe the mobile team's data).
- **Neon cold start:** the first request after idle may be slow or need one retry.
- **docs/PROJECT-CONTEXT.md is stale** on the deposit/second-chance model (it still says "held until close, forfeited, deposit-backed second-chance"). That's expected — it will be updated when the `orders`/`scheduler` modules are built. See the spec's §1 for the authoritative model.
