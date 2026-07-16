# Scheduler + Orders Implementation Plan

**Goal:** Close auctions on time, pick the winner, take the money, and credit the seller — with a 72h payment window, an optional second-chance offer, and deposit forfeiture on default.

**Architecture:** A `scheduler` module (thin `@nestjs/schedule` cron, zero business logic) drives three idempotent catch-up jobs in the `orders` module. `OrdersService` owns the single payment path (`payOrder`) plus the user-facing reads; `SettlementService` owns the three time-driven jobs and calls `payOrder`. Every transition is a row-locked transaction with a conditional guard so two scheduler instances can't double-process.

**Tech Stack:** NestJS 11, `@nestjs/schedule` (new dependency), Prisma 7 (custom client at `generated/prisma`), PostgreSQL (Neon), TypeScript, Swagger via `applyDecorators`.

## Global Constraints

- **Prisma access:** inject `DatabaseService` (conventionally `prisma`); never `new PrismaClient`.
- **Types/enums:** import from `generated/prisma/client` (e.g. `import { OrderStatus, Prisma } from 'generated/prisma/client'`).
- **Money:** always `Prisma.Decimal`, `Decimal(12,2)`, USD. Serialize to responses as `.toFixed(2)` strings.
- **Deposit:** flat **$50**. `amountDue = max(0, amount − 50)` for `offerRank = 1`; `depositApplied = 0` and `amountDue = amount` for `offerRank = 2`.
- **Payment window:** **72 hours** (`paymentDeadline = now + 72h`).
- **Second chance:** **2nd-highest bidder only** (the highest bid whose `bidderId != buyerId`), at **their own bid price**, **never auto-charged**, then `UNSOLD`.
- **Winner default:** deposit **FORFEITED**; order `DEFAULTED`. **Rank-2 lapse:** order `CANCELLED` (no deposit to forfeit).
- **No escrow:** payment credits the seller's wallet immediately → order `COMPLETED`. Never use `PAID_IN_ESCROW`/`DISPUTED`/`REFUNDED`/`autoReleaseAt`.
- **Atomic debits:** guard every wallet debit with a conditional `updateMany` (`where: { balance: { gte: X } }`) + affected-count check — never read-then-write. (Matches `requestWithdrawal` / `holdBidDeposit`.)
- **Auth is global:** every route protected by default. `req.user!` is a `SafeUser`. Restrict with `@Roles([Role.ADMIN])`.
- **Zod pipe:** if a handler has a path param, apply Zod **inline on the body** (`@Body(new ZodValidationPipe(schema))`), never method-level `@UsePipes` — see the docs/PROJECT-CONTEXT.md gotcha. (No endpoint here takes a body, so no Zod schema is needed.)
- **Migrations:** additive only. Use `prisma migrate diff` → hand-place SQL → `prisma migrate deploy`. **NEVER `prisma migrate dev`** (drift on `20260706160744_category_enum` makes it want a DB reset, which would wipe the mobile team's data).
- **Testing:** live HTTP endpoint testing (`test-endpoints` skill), NOT jest. No `.spec.ts` files. Each build task's gate is `npx tsc --noEmit`.
- **Commits:** local only, one per task. **Never push.**

**Spec:** `docs/design/specs/2026-07-16-scheduler-orders-design.md`

---

### Task 1: Schema — add PURCHASE/SALE/APPLIED + the deadline index

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260716120000_orders_purchase_sale_applied/migration.sql`

**Interfaces:**
- Produces (used by Tasks 4, 5): `WalletTxnType.PURCHASE`, `WalletTxnType.SALE`, `DepositStatus.APPLIED`.

- [ ] **Step 1: Add the enum values in the schema**

In `prisma/schema.prisma`, change the `DepositStatus` enum to:

```prisma
enum DepositStatus {
  HELD // محجوز
  RELEASED // أُرجِع
  FORFEITED // صودِر (تخلّف عن الدفع)
  APPLIED // احتُسب من ثمن الشراء
}
```

and add two values to `WalletTxnType` (keep the existing ones untouched — `ESCROW_IN`/`ESCROW_RELEASE` stay, unused):

```prisma
enum WalletTxnType {
  TOPUP // شحن (عبر البوابة)
  WITHDRAW // سحب
  DEPOSIT_HOLD // حجز عربون $50
  DEPOSIT_RELEASE // إرجاع العربون
  DEPOSIT_FORFEIT // مصادرة العربون
  PURCHASE // خصم ثمن الشراء من المشتري
  SALE // إيداع ثمن البيع للبائع
  ESCROW_IN // (غير مستخدم — أُلغي الـ escrow)
  ESCROW_RELEASE // (غير مستخدم — أُلغي الـ escrow)
  REFUND // استرجاع للمشتري
}
```

- [ ] **Step 2: Add the index Job B needs**

`Order` is queried every minute by `WHERE status = ? AND paymentDeadline <= now()`. Add that index next to the existing ones in the `Order` model (leave `@@index([status, autoReleaseAt])` alone):

```prisma
  @@index([auctionId])
  @@index([buyerId, status])
  @@index([sellerId, status])
  @@index([status, autoReleaseAt]) // لمهمة التحرير التلقائي
  @@index([status, paymentDeadline]) // لمهمة انتهاء المهلة (كل دقيقة)
```

- [ ] **Step 3: Preview the migration SQL (optional cross-check)**

Run:
```bash
npx prisma migrate diff --from-config-datasource prisma.config.ts --to-schema-datamodel prisma/schema.prisma --script
```
Expected: SQL printed to stdout with three `ALTER TYPE ... ADD VALUE` statements and one `CREATE INDEX`.

This step is only a cross-check — `migrate diff` flag names differ between Prisma versions. If the flags are rejected, **skip this step**: the SQL in Step 4 is authoritative and hand-placed either way.

- [ ] **Step 4: Hand-place the migration file**

Create `prisma/migrations/20260716120000_orders_purchase_sale_applied/migration.sql` with exactly:

```sql
-- AlterEnum
ALTER TYPE "DepositStatus" ADD VALUE 'APPLIED';

-- AlterEnum
ALTER TYPE "WalletTxnType" ADD VALUE 'PURCHASE';
ALTER TYPE "WalletTxnType" ADD VALUE 'SALE';

-- CreateIndex
CREATE INDEX "Order_status_paymentDeadline_idx" ON "Order"("status", "paymentDeadline");
```

Note: `ALTER TYPE ... ADD VALUE` inside a transaction is fine on PostgreSQL 12+ (Neon runs 15+) **as long as the new value isn't used in the same migration** — it isn't here.

- [ ] **Step 5: Apply the migration and regenerate the client**

Run:
```bash
npx prisma migrate deploy && npx prisma generate
```
Expected: `migrate deploy` reports the new migration applied; `generate` succeeds. **Do NOT run `prisma migrate dev`.**

- [ ] **Step 6: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260716120000_orders_purchase_sale_applied/migration.sql
git commit -m "feat(orders): add PURCHASE/SALE/APPLIED enums + payment-deadline index"
```

---

### Task 2: MailService — five settlement emails

**Files:**
- Modify: `src/modules/mail/mail.service.ts`

**Interfaces:**
- Produces (used by Tasks 4, 5):
  - `sendPaymentRequired(to: string, fullName: string, auctionTitle: string, amountDue: string, deadline: Date): Promise<void>`
  - `sendOrderPaid(to: string, fullName: string, auctionTitle: string, amount: string): Promise<void>`
  - `sendItemSold(to: string, fullName: string, auctionTitle: string, amount: string, buyerEmail: string): Promise<void>`
  - `sendSecondChance(to: string, fullName: string, auctionTitle: string, amount: string, deadline: Date): Promise<void>`
  - `sendAuctionUnsold(to: string, fullName: string, auctionTitle: string): Promise<void>`
  - All amounts are preformatted strings (e.g. `"200.00"`), rendered as `$${amount}`.

- [ ] **Step 1: Add the five public methods**

Add to the `MailService` class in `src/modules/mail/mail.service.ts`, after the existing `sendOutbid` method and before the private `send`:

```ts
  async sendPaymentRequired(
    to: string,
    fullName: string,
    auctionTitle: string,
    amountDue: string,
    deadline: Date,
  ): Promise<void> {
    const subject = `You won ${auctionTitle} — payment needed`;
    const html = this.buildSettlementHtml(
      fullName,
      `You won <strong>${auctionTitle}</strong>! Your $50 deposit covers part of it — <strong>$${amountDue}</strong> is still due.`,
      `Top up your wallet and pay before ${deadline.toUTCString()}, or the item goes to the next bidder and your deposit is forfeited.`,
      '#fff7ed',
      '#9a3412',
    );
    const text =
      `Hi ${fullName},\n\n` +
      `You won "${auctionTitle}". Amount due: $${amountDue}.\n` +
      `Pay from your wallet before ${deadline.toUTCString()}, or the item is offered to the next bidder and your $50 deposit is forfeited.\n\n` +
      `Bid Smart. Win Big.`;
    await this.send({ to, subject, html, text });
  }

  async sendOrderPaid(
    to: string,
    fullName: string,
    auctionTitle: string,
    amount: string,
  ): Promise<void> {
    const subject = `You won ${auctionTitle} — payment complete`;
    const html = this.buildSettlementHtml(
      fullName,
      `Congratulations — <strong>${auctionTitle}</strong> is yours for <strong>$${amount}</strong>.`,
      'Payment is complete. Contact the seller by email to arrange the handover.',
      '#f0fdf4',
      '#166534',
    );
    const text =
      `Hi ${fullName},\n\n` +
      `You won "${auctionTitle}" for $${amount} and payment is complete.\n` +
      `Contact the seller by email to arrange the handover.\n\n` +
      `Bid Smart. Win Big.`;
    await this.send({ to, subject, html, text });
  }

  async sendItemSold(
    to: string,
    fullName: string,
    auctionTitle: string,
    amount: string,
    buyerEmail: string,
  ): Promise<void> {
    const subject = `Your item sold: ${auctionTitle}`;
    const html = this.buildSettlementHtml(
      fullName,
      `<strong>${auctionTitle}</strong> sold for <strong>$${amount}</strong> — the funds are in your wallet.`,
      `Contact the buyer at <a href="mailto:${buyerEmail}">${buyerEmail}</a> to arrange the handover.`,
      '#f0fdf4',
      '#166534',
    );
    const text =
      `Hi ${fullName},\n\n` +
      `"${auctionTitle}" sold for $${amount}. The funds are in your wallet.\n` +
      `Contact the buyer at ${buyerEmail} to arrange the handover.\n\n` +
      `Bid Smart. Win Big.`;
    await this.send({ to, subject, html, text });
  }

  async sendSecondChance(
    to: string,
    fullName: string,
    auctionTitle: string,
    amount: string,
    deadline: Date,
  ): Promise<void> {
    const subject = `Second chance: ${auctionTitle} is available`;
    const html = this.buildSettlementHtml(
      fullName,
      `The winning bidder for <strong>${auctionTitle}</strong> didn't pay — it's yours at your bid of <strong>$${amount}</strong> if you want it.`,
      `This offer is optional. Pay from your wallet before ${deadline.toUTCString()} to claim it; ignore it and nothing happens.`,
      '#eff6ff',
      '#1e40af',
    );
    const text =
      `Hi ${fullName},\n\n` +
      `The winning bidder for "${auctionTitle}" didn't pay. You can buy it at your bid of $${amount}.\n` +
      `This is optional — pay from your wallet before ${deadline.toUTCString()} to claim it.\n\n` +
      `Bid Smart. Win Big.`;
    await this.send({ to, subject, html, text });
  }

  async sendAuctionUnsold(
    to: string,
    fullName: string,
    auctionTitle: string,
  ): Promise<void> {
    const subject = `Your auction ended unsold: ${auctionTitle}`;
    const html = this.buildSettlementHtml(
      fullName,
      `<strong>${auctionTitle}</strong> ended without a completed sale.`,
      'The item is back in your collection — you can list it again any time.',
      '#f3f4f6',
      '#374151',
    );
    const text =
      `Hi ${fullName},\n\n` +
      `"${auctionTitle}" ended without a completed sale. The item is back in your collection and you can list it again any time.\n\n` +
      `Bid Smart. Win Big.`;
    await this.send({ to, subject, html, text });
  }
```

- [ ] **Step 2: Add the shared private HTML builder**

One builder for all five (they differ only in copy and callout colour). Add it near the other `build...Html` private methods:

```ts
  private buildSettlementHtml(
    fullName: string,
    lead: string,
    calloutHtml: string,
    calloutBg: string,
    calloutColor: string,
  ): string {
    return `
  <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
    <h2 style="margin: 0 0 16px;">Bid Smart. Win Big.</h2>
    <p>Hi ${fullName},</p>
    <p>${lead}</p>
    <p style="background: ${calloutBg}; border-radius: 8px; padding: 12px 16px; color: ${calloutColor};">
      ${calloutHtml}
    </p>
    <p style="font-size: 13px; color: #6b7280;">GalleryQ</p>
  </div>`;
  }
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/modules/mail/mail.service.ts
git commit -m "feat(mail): add settlement emails (payment required, paid, sold, second chance, unsold)"
```

---

### Task 3: Orders DTOs

**Files:**
- Create: `src/modules/orders/dto/orders.dto.ts`

**Interfaces:**
- Produces (used by Tasks 4, 5, 6, 7): `OrderListItem`, `OrdersResponse`, `OrderDetail`, `SchedulerRunResponse`.

No request DTO and no Zod schema: none of the endpoints take a body.

- [ ] **Step 1: Create the response types**

Create `src/modules/orders/dto/orders.dto.ts`:

```ts
import type { OrderStatus } from 'generated/prisma/client';

// ===== Response shapes =====

export type OrderListItem = {
  id: string;
  auctionId: string;
  title: string;
  mainImage: string;
  amount: string; // "200.00" — the full price
  depositApplied: string; // "50.00" for the winner, "0.00" for a second-chance offer
  amountDue: string; // what the buyer still pays from balance
  offerRank: number; // 1 = winner, 2 = second chance
  status: OrderStatus;
  paymentDeadline: Date;
  paidAt: Date | null;
  createdAt: Date;
};

export type OrdersResponse = {
  items: OrderListItem[];
  page: number;
  limit: number;
  total: number;
};

// The counterpart's email is exposed so buyer and seller can arrange handover
// over `mailto:` — there is no in-app chat.
export type OrderDetail = OrderListItem & {
  counterpart: {
    role: 'BUYER' | 'SELLER'; // who the counterpart is, relative to the caller
    fullName: string;
    email: string;
  };
};

export type SchedulerRunResponse = {
  closed: number; // auctions closed this tick
  expired: number; // orders whose deadline lapsed this tick
  retriedPaid: number; // pending winner orders paid by the retry job
};
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/modules/orders/dto/orders.dto.ts
git commit -m "feat(orders): add order response DTOs"
```

---

### Task 4: OrdersService — payOrder() + reads

**Files:**
- Create: `src/modules/orders/orders.service.ts`

**Interfaces:**
- Consumes: `DatabaseService`, `MailService.sendOrderPaid`/`sendItemSold` (Task 2), DTO types (Task 3).
- Produces (used by Tasks 5, 6):
  - `DEPOSIT_AMOUNT: Prisma.Decimal` (exported const, `50`)
  - `PAYMENT_WINDOW_MS: number` (exported const, 72h in ms)
  - `payOrder(orderId: string, actingUserId?: string): Promise<OrderListItem>` — throws `NotFoundException` / `ForbiddenException` / `BadRequestException`. Pass `actingUserId` only from the endpoint (ownership check); automated callers omit it.
  - `getMyOrders(userId: string, page?: number, limit?: number): Promise<OrdersResponse>`
  - `getMySales(userId: string, page?: number, limit?: number): Promise<OrdersResponse>`
  - `getOrder(orderId: string, userId: string): Promise<OrderDetail>`

- [ ] **Step 1: Create the service with constants, `payOrder`, and helpers**

Create `src/modules/orders/orders.service.ts`:

```ts
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuctionStatus,
  DepositStatus,
  ObjectStatus,
  OrderStatus,
  Prisma,
  WalletTxnType,
  type Order,
} from 'generated/prisma/client';
import { DatabaseService } from '../database/database.service';
import { MailService } from '../mail/mail.service';
import type { OrderDetail, OrderListItem, OrdersResponse } from './dto/orders.dto';

// العربون الثابت + مهلة الدفع (72 ساعة)
export const DEPOSIT_AMOUNT = new Prisma.Decimal(50);
export const PAYMENT_WINDOW_MS = 72 * 60 * 60 * 1000;

// كل قراءة/كتابة للطلب تحتاج عنوان القطعة وصورتها
const ORDER_INCLUDE = {
  auction: {
    select: {
      id: true,
      objectId: true,
      object: { select: { title: true, mainImage: true } },
    },
  },
} satisfies Prisma.OrderInclude;

type OrderWithAuction = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: DatabaseService,
    private readonly mail: MailService,
  ) {}

  // مسار الدفع الوحيد — يستخدمه الخصم التلقائي عند الإغلاق، وزر الدفع، وإعادة المحاولة.
  // يرمي عند أي فشل؛ المنادون الآليون يلتقطون الاستثناء ويتجاهلونه.
  async payOrder(orderId: string, actingUserId?: string): Promise<OrderListItem> {
    const ctx = await this.prisma.$transaction(async (tx) => {
      // "Order" كلمة محجوزة في SQL — لازم تظل بعلامات اقتباس
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;

      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: ORDER_INCLUDE,
      });
      if (!order) throw new NotFoundException('Order not found');

      // فحص الملكية للـ endpoint فقط
      if (actingUserId && order.buyerId !== actingUserId) {
        throw new ForbiddenException('This order is not yours');
      }
      if (order.status !== OrderStatus.AWAITING_PAYMENT) {
        throw new BadRequestException('This order is not awaiting payment');
      }
      const now = new Date();
      if (order.paymentDeadline <= now) {
        throw new BadRequestException('The payment deadline has passed');
      }

      const usesDeposit = order.depositApplied.greaterThan(0);

      const buyerWallet = await tx.wallet.upsert({
        where: { userId: order.buyerId },
        create: { userId: order.buyerId },
        update: {},
      });

      // خصم ذرّي محمي — يمنع الرصيد السالب تحت التزامن
      const debit = await tx.wallet.updateMany({
        where: { id: buyerWallet.id, balance: { gte: order.amountDue } },
        data: {
          balance: { decrement: order.amountDue },
          ...(usesDeposit && {
            lockedBalance: { decrement: order.depositApplied },
          }),
        },
      });
      if (debit.count === 0) {
        const fresh = await tx.wallet.findUniqueOrThrow({
          where: { id: buyerWallet.id },
        });
        throw new BadRequestException(
          `Insufficient balance. Needed: $${order.amountDue.toFixed(
            2,
          )}, available: $${fresh.balance.toFixed(2)}. Top up your wallet.`,
        );
      }

      // العربون أكبر من الثمن → رُدّ الفرق للمشتري
      if (usesDeposit && order.depositApplied.greaterThan(order.amount)) {
        const excess = order.depositApplied.minus(order.amount);
        await tx.wallet.update({
          where: { id: buyerWallet.id },
          data: { balance: { increment: excess } },
        });
        await tx.walletTransaction.create({
          data: {
            walletId: buyerWallet.id,
            type: WalletTxnType.REFUND,
            amount: excess,
            refId: order.id,
            note: 'Deposit exceeded the final price',
          },
        });
      }

      if (usesDeposit) {
        await tx.auctionDeposit.updateMany({
          where: {
            auctionId: order.auctionId,
            userId: order.buyerId,
            status: DepositStatus.HELD,
          },
          data: { status: DepositStatus.APPLIED },
        });
      }

      // سجل المشتري: الثمن الكامل (جزء منه جا من العربون)
      await tx.walletTransaction.create({
        data: {
          walletId: buyerWallet.id,
          type: WalletTxnType.PURCHASE,
          amount: order.amount,
          refId: order.id,
          note: usesDeposit
            ? `Auction purchase ($${order.depositApplied.toFixed(2)} from deposit)`
            : 'Auction purchase (second chance)',
        },
      });

      // البائع يقبض فوراً — ما في escrow
      const sellerWallet = await tx.wallet.upsert({
        where: { userId: order.sellerId },
        create: { userId: order.sellerId },
        update: {},
      });
      await tx.wallet.update({
        where: { id: sellerWallet.id },
        data: { balance: { increment: order.amount } },
      });
      await tx.walletTransaction.create({
        data: {
          walletId: sellerWallet.id,
          type: WalletTxnType.SALE,
          amount: order.amount,
          refId: order.id,
          note: 'Auction sale',
        },
      });

      const updated = await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.COMPLETED, paidAt: now, completedAt: now },
        include: ORDER_INCLUDE,
      });
      await tx.auction.update({
        where: { id: order.auctionId },
        data: { status: AuctionStatus.SOLD },
      });
      await tx.object.update({
        where: { id: order.auction.objectId },
        data: { status: ObjectStatus.SOLD },
      });

      return updated;
    });

    void this.notifyPaid(ctx);
    return this.format(ctx);
  }

  // إيميلات ما بعد الـ commit — فشل البريد ما بيفشّل الدفع
  private async notifyPaid(order: OrderWithAuction): Promise<void> {
    try {
      const [buyer, seller] = await Promise.all([
        this.prisma.user.findUnique({
          where: { id: order.buyerId },
          select: { email: true, fullName: true },
        }),
        this.prisma.user.findUnique({
          where: { id: order.sellerId },
          select: { email: true, fullName: true },
        }),
      ]);
      const title = order.auction.object.title;
      const amount = order.amount.toFixed(2);
      if (buyer) {
        await this.mail.sendOrderPaid(buyer.email, buyer.fullName, title, amount);
      }
      if (seller && buyer) {
        await this.mail.sendItemSold(
          seller.email,
          seller.fullName,
          title,
          amount,
          buyer.email,
        );
      }
    } catch {
      // تجاهل — البريد لا يُفشِل الدفع
    }
  }

  private format(order: OrderWithAuction): OrderListItem {
    return {
      id: order.id,
      auctionId: order.auctionId,
      title: order.auction.object.title,
      mainImage: order.auction.object.mainImage,
      amount: order.amount.toFixed(2),
      depositApplied: order.depositApplied.toFixed(2),
      amountDue: order.amountDue.toFixed(2),
      offerRank: order.offerRank,
      status: order.status,
      paymentDeadline: order.paymentDeadline,
      paidAt: order.paidAt,
      createdAt: order.createdAt,
    };
  }

  private clampPaging(page?: number, limit?: number) {
    const safePage = page && page > 0 ? page : 1;
    const safeLimit = limit && limit > 0 && limit <= 100 ? limit : 20;
    return { safePage, safeLimit, skip: (safePage - 1) * safeLimit };
  }
```

- [ ] **Step 2: Add the three read methods and close the class**

Append inside the class (after `clampPaging`):

```ts
  // طلباتي كمشتري
  async getMyOrders(
    userId: string,
    page?: number,
    limit?: number,
  ): Promise<OrdersResponse> {
    return this.listOrders({ buyerId: userId }, page, limit);
  }

  // مبيعاتي كبائع
  async getMySales(
    userId: string,
    page?: number,
    limit?: number,
  ): Promise<OrdersResponse> {
    return this.listOrders({ sellerId: userId }, page, limit);
  }

  private async listOrders(
    where: Prisma.OrderWhereInput,
    page?: number,
    limit?: number,
  ): Promise<OrdersResponse> {
    const { safePage, safeLimit, skip } = this.clampPaging(page, limit);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        include: ORDER_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
      }),
      this.prisma.order.count({ where }),
    ]);
    return {
      items: rows.map((row) => this.format(row)),
      page: safePage,
      limit: safeLimit,
      total,
    };
  }

  // تفاصيل الطلب — للمشتري أو البائع فقط، مع إيميل الطرف الآخر للتواصل
  async getOrder(orderId: string, userId: string): Promise<OrderDetail> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        ...ORDER_INCLUDE,
        buyer: { select: { fullName: true, email: true } },
        seller: { select: { fullName: true, email: true } },
      },
    });
    if (!order) throw new NotFoundException('Order not found');

    const isBuyer = order.buyerId === userId;
    const isSeller = order.sellerId === userId;
    if (!isBuyer && !isSeller) throw new ForbiddenException();

    // الطرف الآخر بالنسبة للمنادي
    const counterpart = isBuyer
      ? { role: 'SELLER' as const, ...order.seller }
      : { role: 'BUYER' as const, ...order.buyer };

    return { ...this.format(order), counterpart };
  }
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors. (`Order` is imported as a type but only `OrderWithAuction` is used — if tsc flags the unused `type Order` import, remove it from the import list.)

- [ ] **Step 4: Commit**

```bash
git add src/modules/orders/orders.service.ts
git commit -m "feat(orders): add OrdersService (payOrder + reads)"
```

---

### Task 5: SettlementService — the three scheduler jobs

**Files:**
- Create: `src/modules/orders/settlement.service.ts`

**Interfaces:**
- Consumes: `DatabaseService`, `OrdersService.payOrder` + `DEPOSIT_AMOUNT` + `PAYMENT_WINDOW_MS` (Task 4), `MailService.sendPaymentRequired`/`sendSecondChance`/`sendAuctionUnsold` (Task 2).
- Produces (used by Task 7):
  - `closeDueAuctions(): Promise<number>` — returns how many auctions were closed
  - `expirePaymentDeadlines(): Promise<number>` — returns how many orders lapsed
  - `retryWinnerPayments(): Promise<number>` — returns how many pending winner orders got paid

- [ ] **Step 1: Create the service with `closeDueAuctions`**

Create `src/modules/orders/settlement.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import {
  AuctionStatus,
  DepositStatus,
  ObjectStatus,
  OrderStatus,
  Prisma,
  WalletTxnType,
} from 'generated/prisma/client';
import { DatabaseService } from '../database/database.service';
import { MailService } from '../mail/mail.service';
import { DEPOSIT_AMOUNT, PAYMENT_WINDOW_MS, OrdersService } from './orders.service';

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// مالك القطعة + عنوانها — نحتاجهم لكل إيميل تسوية
const AUCTION_INCLUDE = {
  object: {
    select: {
      id: true,
      ownerId: true,
      title: true,
      owner: { select: { email: true, fullName: true } },
    },
  },
} satisfies Prisma.AuctionInclude;

@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly prisma: DatabaseService,
    private readonly orders: OrdersService,
    private readonly mail: MailService,
  ) {}

  // ===== المهمة أ: إغلاق المزادات المستحقّة =====

  async closeDueAuctions(): Promise<number> {
    const due = await this.prisma.auction.findMany({
      where: { status: AuctionStatus.LIVE, endTime: { lte: new Date() } },
      select: { id: true },
    });

    let closed = 0;
    for (const { id } of due) {
      try {
        if (await this.closeOne(id)) closed++;
      } catch (e) {
        // مزاد واحد فشل ما بيوقّف الباقي — الدورة الجاية بتعيد المحاولة
        this.logger.error(`closeDueAuctions failed for ${id}: ${msg(e)}`);
      }
    }
    return closed;
  }

  private async closeOne(auctionId: string): Promise<boolean> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Auction" WHERE id = ${auctionId} FOR UPDATE`;

      const auction = await tx.auction.findUnique({
        where: { id: auctionId },
        include: AUCTION_INCLUDE,
      });
      // نسخة ثانية سبقتنا، أو تمدّد الوقت (anti-snipe) بين الاستعلام والقفل
      if (!auction || auction.status !== AuctionStatus.LIVE) return null;
      if (!auction.endTime || auction.endTime > new Date()) return null;

      // بلا مزايدات → UNSOLD والقطعة ترجع لصاحبها
      if (!auction.currentWinnerId) {
        await tx.auction.update({
          where: { id: auctionId },
          data: { status: AuctionStatus.UNSOLD },
        });
        await tx.object.update({
          where: { id: auction.objectId },
          data: { status: ObjectStatus.AVAILABLE },
        });
        return {
          kind: 'unsold' as const,
          seller: auction.object.owner,
          title: auction.object.title,
        };
      }

      // في فائز → ENDED + Order برتبة 1
      const amount = auction.currentPrice;
      const amountDue = amount.greaterThan(DEPOSIT_AMOUNT)
        ? amount.minus(DEPOSIT_AMOUNT)
        : new Prisma.Decimal(0);

      await tx.auction.update({
        where: { id: auctionId },
        data: { status: AuctionStatus.ENDED },
      });
      const order = await tx.order.create({
        data: {
          auctionId,
          buyerId: auction.currentWinnerId,
          sellerId: auction.object.ownerId,
          amount,
          depositApplied: DEPOSIT_AMOUNT,
          amountDue,
          offerRank: 1,
          status: OrderStatus.AWAITING_PAYMENT,
          paymentDeadline: new Date(Date.now() + PAYMENT_WINDOW_MS),
        },
      });

      return {
        kind: 'ordered' as const,
        orderId: order.id,
        buyerId: auction.currentWinnerId,
        title: auction.object.title,
        amountDue: amountDue.toFixed(2),
        deadline: order.paymentDeadline,
      };
    });

    if (!outcome) return false;

    if (outcome.kind === 'unsold') {
      void this.safeMail(() =>
        this.mail.sendAuctionUnsold(
          outcome.seller.email,
          outcome.seller.fullName,
          outcome.title,
        ),
      );
      return true;
    }

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
  }

  private async safeMail(send: () => Promise<void>): Promise<void> {
    try {
      await send();
    } catch {
      // البريد لا يُفشِل التسوية
    }
  }
```

- [ ] **Step 2: Add `expirePaymentDeadlines` (forfeit + second chance)**

Append inside the class:

```ts
  // ===== المهمة ب: انتهاء مهلة الدفع =====

  async expirePaymentDeadlines(): Promise<number> {
    const due = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.AWAITING_PAYMENT,
        paymentDeadline: { lte: new Date() },
      },
      select: { id: true },
    });

    let handled = 0;
    for (const { id } of due) {
      try {
        if (await this.expireOne(id)) handled++;
      } catch (e) {
        this.logger.error(`expirePaymentDeadlines failed for ${id}: ${msg(e)}`);
      }
    }
    return handled;
  }

  private async expireOne(orderId: string): Promise<boolean> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;

      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { auction: { include: AUCTION_INCLUDE } },
      });
      // دُفع للتو، أو نسخة ثانية عالجته
      if (!order || order.status !== OrderStatus.AWAITING_PAYMENT) return null;
      if (order.paymentDeadline > new Date()) return null;

      const title = order.auction.object.title;
      const seller = order.auction.object.owner;

      // ---- رتبة 2: العرض الاختياري انتهى → إلغاء، بلا مصادرة (ما في عربون) ----
      if (order.offerRank !== 1) {
        await tx.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.CANCELLED },
        });
        await tx.auction.update({
          where: { id: order.auctionId },
          data: { status: AuctionStatus.UNSOLD },
        });
        await tx.object.update({
          where: { id: order.auction.objectId },
          data: { status: ObjectStatus.AVAILABLE },
        });
        return { kind: 'unsold' as const, seller, title };
      }

      // ---- رتبة 1: الفائز تخلّف → صادر الـ$50 ----
      const forfeited = await tx.auctionDeposit.updateMany({
        where: {
          auctionId: order.auctionId,
          userId: order.buyerId,
          status: DepositStatus.HELD,
        },
        data: { status: DepositStatus.FORFEITED },
      });
      if (forfeited.count > 0) {
        const wallet = await tx.wallet.findUnique({
          where: { userId: order.buyerId },
        });
        if (wallet) {
          await tx.wallet.update({
            where: { id: wallet.id },
            data: { lockedBalance: { decrement: DEPOSIT_AMOUNT } },
          });
          await tx.walletTransaction.create({
            data: {
              walletId: wallet.id,
              type: WalletTxnType.DEPOSIT_FORFEIT,
              amount: DEPOSIT_AMOUNT,
              refId: order.auctionId,
              note: 'Deposit forfeited — payment deadline missed',
            },
          });
        }
      }
      await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.DEFAULTED },
      });

      // ثاني أعلى مزايد = أعلى مزايدة لشخص غير الفائز
      const second = await tx.bid.findFirst({
        where: { auctionId: order.auctionId, bidderId: { not: order.buyerId } },
        orderBy: { amount: 'desc' },
        include: { bidder: { select: { id: true, email: true, fullName: true } } },
      });

      if (!second) {
        await tx.auction.update({
          where: { id: order.auctionId },
          data: { status: AuctionStatus.UNSOLD },
        });
        await tx.object.update({
          where: { id: order.auction.objectId },
          data: { status: ObjectStatus.AVAILABLE },
        });
        return { kind: 'unsold' as const, seller, title };
      }

      // عرض الفرصة الثانية بسعر مزايدته هو، بلا عربون
      const offer = await tx.order.create({
        data: {
          auctionId: order.auctionId,
          buyerId: second.bidderId,
          sellerId: order.sellerId,
          amount: second.amount,
          depositApplied: new Prisma.Decimal(0),
          amountDue: second.amount,
          offerRank: 2,
          status: OrderStatus.AWAITING_PAYMENT,
          paymentDeadline: new Date(Date.now() + PAYMENT_WINDOW_MS),
        },
      });

      return {
        kind: 'second' as const,
        title,
        bidder: second.bidder,
        amount: second.amount.toFixed(2),
        deadline: offer.paymentDeadline,
      };
    });

    if (!outcome) return false;

    if (outcome.kind === 'unsold') {
      void this.safeMail(() =>
        this.mail.sendAuctionUnsold(
          outcome.seller.email,
          outcome.seller.fullName,
          outcome.title,
        ),
      );
    } else {
      void this.safeMail(() =>
        this.mail.sendSecondChance(
          outcome.bidder.email,
          outcome.bidder.fullName,
          outcome.title,
          outcome.amount,
          outcome.deadline,
        ),
      );
    }
    return true;
  }
```

- [ ] **Step 3: Add `retryWinnerPayments` and close the class**

Append inside the class:

```ts
  // ===== المهمة ج: إعادة محاولة دفع الفائز (رتبة 1 فقط) =====
  // رتبة 2 مستثناة عمداً: العرض اختياري وما بينخصم تلقائياً أبداً.

  async retryWinnerPayments(): Promise<number> {
    const pending = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.AWAITING_PAYMENT,
        offerRank: 1,
        paymentDeadline: { gt: new Date() },
      },
      select: { id: true },
    });

    let paid = 0;
    for (const { id } of pending) {
      try {
        await this.orders.payOrder(id);
        paid++;
      } catch {
        // لسّا رصيده ناقص — عادي، نحاول الدورة الجاية
      }
    }
    return paid;
  }
}
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/modules/orders/settlement.service.ts
git commit -m "feat(orders): add SettlementService (close, expire+second-chance, retry)"
```

---

### Task 6: Orders swagger + controller + module

**Files:**
- Create: `src/swagger/orders.swagger.ts`
- Create: `src/modules/orders/orders.controller.ts`
- Create: `src/modules/orders/orders.module.ts`

**Interfaces:**
- Consumes: `OrdersService` (Task 4), `SettlementService` (Task 5), DTO types (Task 3).
- Produces (used by Task 7): `OrdersModule` exporting `SettlementService`.

- [ ] **Step 1: Create the swagger decorators**

Create `src/swagger/orders.swagger.ts`:

```ts
import { applyDecorators } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiUnauthorizedResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';

export const SwaggerOrdersTag = () => ApiTags('Orders');

export const ApiPayOrder = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({
      summary:
        'Pay for a won auction from my wallet (deposit is applied; seller is credited immediately)',
    }),
    ApiParam({ name: 'id', description: 'Order id' }),
    ApiOkResponse({ description: 'The completed order' }),
    ApiBadRequestResponse({
      description: 'Not awaiting payment / deadline passed / insufficient balance',
    }),
    ApiForbiddenResponse({ description: 'This order is not yours' }),
    ApiNotFoundResponse({ description: 'Order not found' }),
    ApiUnauthorizedResponse({ description: 'Login required' }),
  );

export const ApiMyOrders = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'List my orders as a buyer (newest first)' }),
    ApiQuery({ name: 'page', required: false, example: 1 }),
    ApiQuery({ name: 'limit', required: false, example: 20 }),
    ApiOkResponse({ description: '{ items, page, limit, total }' }),
    ApiUnauthorizedResponse({ description: 'Login required' }),
  );

export const ApiMySales = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'List my sales as a seller (newest first)' }),
    ApiQuery({ name: 'page', required: false, example: 1 }),
    ApiQuery({ name: 'limit', required: false, example: 20 }),
    ApiOkResponse({ description: '{ items, page, limit, total }' }),
    ApiUnauthorizedResponse({ description: 'Login required' }),
  );

export const ApiGetOrder = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({
      summary:
        "Order detail — buyer or seller only; includes the counterpart's email for mailto: contact",
    }),
    ApiParam({ name: 'id', description: 'Order id' }),
    ApiOkResponse({ description: 'Order + counterpart { role, fullName, email }' }),
    ApiForbiddenResponse({ description: 'Not your order' }),
    ApiNotFoundResponse({ description: 'Order not found' }),
    ApiUnauthorizedResponse({ description: 'Login required' }),
  );
```

- [ ] **Step 2: Create the controller**

No endpoint takes a body, so there is no Zod pipe here.

Create `src/modules/orders/orders.controller.ts`:

```ts
import { Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { OrdersService } from './orders.service';
import type {
  OrderDetail,
  OrderListItem,
  OrdersResponse,
} from './dto/orders.dto';
import {
  SwaggerOrdersTag,
  ApiPayOrder,
  ApiMyOrders,
  ApiMySales,
  ApiGetOrder,
} from 'src/swagger/orders.swagger';

@SwaggerOrdersTag()
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  // ثابتة قبل :id حتى لا تُلتقط كمعرّف
  @Get('mine')
  @ApiMyOrders()
  myOrders(
    @Req() req: Request,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<OrdersResponse> {
    return this.ordersService.getMyOrders(
      req.user!.id,
      page ? Number(page) : undefined,
      limit ? Number(limit) : undefined,
    );
  }

  @Get('sales')
  @ApiMySales()
  mySales(
    @Req() req: Request,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<OrdersResponse> {
    return this.ordersService.getMySales(
      req.user!.id,
      page ? Number(page) : undefined,
      limit ? Number(limit) : undefined,
    );
  }

  @Post(':id/pay')
  @HttpCode(200)
  @ApiPayOrder()
  pay(@Req() req: Request, @Param('id') id: string): Promise<OrderListItem> {
    return this.ordersService.payOrder(id, req.user!.id);
  }

  @Get(':id')
  @ApiGetOrder()
  findOne(@Req() req: Request, @Param('id') id: string): Promise<OrderDetail> {
    return this.ordersService.getOrder(id, req.user!.id);
  }
}
```

- [ ] **Step 3: Create the module**

`MailService` and `DatabaseService` are `@Global`, so nothing needs importing. `SettlementService` is exported for the `scheduler` module.

Create `src/modules/orders/orders.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { SettlementService } from './settlement.service';

@Module({
  controllers: [OrdersController],
  providers: [OrdersService, SettlementService],
  exports: [SettlementService], // يستخدمه موديول scheduler
})
export class OrdersModule {}
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/swagger/orders.swagger.ts src/modules/orders/orders.controller.ts src/modules/orders/orders.module.ts
git commit -m "feat(orders): add orders controller, module and swagger"
```

---

### Task 7: Scheduler module + register both in AppModule

**Files:**
- Modify: `package.json` (add `@nestjs/schedule`)
- Create: `src/swagger/scheduler.swagger.ts`
- Create: `src/modules/scheduler/scheduler.service.ts`
- Create: `src/modules/scheduler/scheduler.controller.ts`
- Create: `src/modules/scheduler/scheduler.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `SettlementService.closeDueAuctions`/`expirePaymentDeadlines`/`retryWinnerPayments` (Task 5), `SchedulerRunResponse` (Task 3).

- [ ] **Step 1: Install `@nestjs/schedule`**

Run:
```bash
npm install @nestjs/schedule
```
Expected: installs and adds the dependency to `package.json`.

- [ ] **Step 2: Create the swagger decorators**

Create `src/swagger/scheduler.swagger.ts`:

```ts
import { applyDecorators } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiForbiddenResponse,
  ApiUnauthorizedResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';

export const SwaggerSchedulerTag = () => ApiTags('Scheduler');

export const ApiRunScheduler = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({
      summary:
        'Run one settlement tick now (ADMIN) — closes due auctions, expires deadlines, retries winner payments',
    }),
    ApiOkResponse({ description: '{ closed, expired, retriedPaid }' }),
    ApiForbiddenResponse({ description: 'Admins only' }),
    ApiUnauthorizedResponse({ description: 'Login required' }),
  );
```

- [ ] **Step 3: Create the scheduler service (timing only)**

Order matters: close first (it creates orders), then expire, then retry.

Create `src/modules/scheduler/scheduler.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SettlementService } from '../orders/settlement.service';
import type { SchedulerRunResponse } from '../orders/dto/orders.dto';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(private readonly settlement: SettlementService) {}

  // كل دقيقة — كل مهمة "تمسح المستحقّ"، فالدورة الفائتة تُلتقط بالدورة الجاية
  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    await this.runAll();
  }

  // نفس المنطق الذي ينادَى يدوياً عبر POST /scheduler/run
  async runAll(): Promise<SchedulerRunResponse> {
    const closed = await this.settlement.closeDueAuctions();
    const expired = await this.settlement.expirePaymentDeadlines();
    const retriedPaid = await this.settlement.retryWinnerPayments();

    // لا نُغرق اللوج بدورات فاضية
    if (closed || expired || retriedPaid) {
      this.logger.log(
        `tick: closed=${closed} expired=${expired} retriedPaid=${retriedPaid}`,
      );
    }
    return { closed, expired, retriedPaid };
  }
}
```

- [ ] **Step 4: Create the admin controller**

Create `src/modules/scheduler/scheduler.controller.ts`:

```ts
import { Controller, HttpCode, Post } from '@nestjs/common';
import { Role } from 'generated/prisma/client';
import { Roles } from 'src/decorators/roles.decorator';
import { SchedulerService } from './scheduler.service';
import type { SchedulerRunResponse } from '../orders/dto/orders.dto';
import {
  SwaggerSchedulerTag,
  ApiRunScheduler,
} from 'src/swagger/scheduler.swagger';

@SwaggerSchedulerTag()
@Controller('scheduler')
export class SchedulerController {
  constructor(private readonly scheduler: SchedulerService) {}

  // ذراع يدوي: للاختبار بدون انتظار الدقيقة، وللإنقاذ لو توقّف الـ cron
  @Post('run')
  @HttpCode(200)
  @Roles([Role.ADMIN])
  @ApiRunScheduler()
  run(): Promise<SchedulerRunResponse> {
    return this.scheduler.runAll();
  }
}
```

- [ ] **Step 5: Create the scheduler module**

Create `src/modules/scheduler/scheduler.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { OrdersModule } from '../orders/orders.module';
import { SchedulerController } from './scheduler.controller';
import { SchedulerService } from './scheduler.service';

@Module({
  imports: [ScheduleModule.forRoot(), OrdersModule],
  controllers: [SchedulerController],
  providers: [SchedulerService],
})
export class SchedulerModule {}
```

- [ ] **Step 6: Register both modules in AppModule**

In `src/app.module.ts`, add these imports with the other module imports:

```ts
import { OrdersModule } from './modules/orders/orders.module';
import { SchedulerModule } from './modules/scheduler/scheduler.module';
```

and add them to the `imports` array, after `BidsModule`:

```ts
    WalletModule,
    BidsModule,
    OrdersModule,
    SchedulerModule,
```

- [ ] **Step 7: Verify it compiles and builds**

Run: `npx tsc --noEmit && npm run build`
Expected: both succeed with no errors.

- [ ] **Step 8: Boot once to confirm the cron registers and routes map**

Run: `npm run start` (stop it with Ctrl-C once the log appears)
Expected: the log shows `Mapped {/orders/mine, GET}`, `Mapped {/orders/:id/pay, POST}`, `Mapped {/scheduler/run, POST}` and `Nest application successfully started` with no `EADDRINUSE`. If port 3000 is busy, free it first (a previous `npm run` child can outlive its wrapper on Windows):
```bash
powershell -Command "Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }"
```

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json src/swagger/scheduler.swagger.ts src/modules/scheduler/ src/app.module.ts
git commit -m "feat(scheduler): add cron tick + admin run endpoint, register orders+scheduler"
```

---

### Task 8: Live endpoint testing

**Files:**
- Create: `scripts/seed-orders-test.ts`
- Create: `scripts/test-orders.mjs`

Uses the `test-endpoints` skill. **Dev DB only** — confirm `DATABASE_URL` in `.env` points at the Neon **dev** branch before the first write (the current one is the user-confirmed dev branch).

**Beating the clock:** seed `endTime` and `paymentDeadline` **in the past** so work is immediately due, and drive ticks with `POST /scheduler/run` (ADMIN) instead of waiting 60s.

**Timezone warning:** `endTime`/`paymentDeadline` are `timestamp` without time zone. A raw `pg` script parses them in the process's local zone while the API treats them as UTC — a ~3h skew. Seed deadlines **hours** in the past (not seconds) so the sign is unambiguous, and compare before/after through **one** client only.

- [ ] **Step 1: Write the seed script**

Create `scripts/seed-orders-test.ts` modelled on `scripts/seed-bids-test.ts` (raw `pg` + argon2 — never the Prisma client under ts-node). It must create, cleaning up its own prior rows first:
- users (password `Test1234!`, argon2-hashed, `ON CONFLICT (email) DO UPDATE`): `seller.orders@test.local` (SELLER), `winner.orders@test.local`, `second.orders@test.local`, `poor.orders@test.local` (all BUYER)
- an ADMIN for `/scheduler/run` — reuse the existing `.env` `ADMIN_EMAIL`/`ADMIN_PASSWORD` admin (run `npm run seed` first)
- wallets: winner `$500`, second `$500`, poor `$50` (enough for the deposit, not for the price)
- five `[TEST]` auctions owned by the seller, each with `status='LIVE'`, `endTime = now() - interval '1 hour'` (already due) unless noted:
  1. **no-bids** — no bids at all
  2. **funded-winner** — winner bid `$200`; `currentPrice=200`, `currentWinnerId=winner`; an `AuctionDeposit` HELD for winner; winner wallet `lockedBalance=50`
  3. **unfunded-winner** — `poor` bid `$200`, is `currentWinnerId`; deposit HELD; poor `balance=0, lockedBalance=50`
  4. **default-then-second** — winner bid `$200` (currentWinner, deposit HELD, locked 50) **and** second bid `$150`; used to test forfeit + second chance
  5. **cheap** — winner bid `$20`; `startingPrice=20`, `currentPrice=20`, deposit HELD, locked 50 → tests the price-below-deposit refund
- print `SEED_RESULT <json>` on the last line with every id/email so the runner can read it

- [ ] **Step 2: Run the seed**

Run:
```bash
npm run seed && npx ts-node --transpile-only scripts/seed-orders-test.ts
```
Expected: `✓ Admin ready: ...` then a `SEED_RESULT {...}` line.

- [ ] **Step 3: Write and run the HTTP test matrix**

Create `scripts/test-orders.mjs` modelled on `scripts/test-bids.mjs` (Node 20+ global `fetch`; log in once per user; one `check()` line per case; exit non-zero on failure). Boot the server first (`npm run dev`), then cover:

1. **no-bids**: `POST /scheduler/run` → auction `UNSOLD`, Object `AVAILABLE`.
2. **funded-winner**: tick → order `COMPLETED`; auction `SOLD`; winner `balance −150`, `lockedBalance 0`; seller `balance +200`; `GET /wallet/transactions` shows `PURCHASE` (buyer) and `SALE` (seller).
3. **unfunded-winner**: tick → order `AWAITING_PAYMENT`, `amountDue "150.00"`; `POST /orders/:id/pay` → `400` insufficient (needed/available).
4. **pay endpoint**: top up `poor` (seed a direct balance update), `POST /orders/:id/pay` → `200`, order `COMPLETED`, auction `SOLD`.
5. **auto-retry**: repeat #3's setup, top up, then `POST /scheduler/run` → paid automatically without calling `/pay`.
6. **default → second chance**: force the deadline into the past (`UPDATE "Order" SET "paymentDeadline" = now() - interval '1 hour'`), tick → rank-1 order `DEFAULTED`, its `AuctionDeposit` `FORFEITED`, winner `lockedBalance −50`, a `DEPOSIT_FORFEIT` txn exists, and a **new rank-2 order** exists for `second` with `amount "150.00"` and `depositApplied "0.00"`.
7. **second chance is never auto-charged**: `second` is funded — run `POST /scheduler/run` again → the rank-2 order is **still** `AWAITING_PAYMENT` and `second`'s balance is unchanged.
8. **second chance pays**: `POST /orders/:id/pay` as `second` → `COMPLETED` at `$150`; auction `SOLD`; seller `+150`.
9. **second chance lapses**: on a separate default, force the rank-2 deadline into the past, tick → order `CANCELLED`, auction `UNSOLD`, Object `AVAILABLE`.
10. **cheap ($20 < $50 deposit)**: tick → `amountDue "0.00"`, order `COMPLETED`, buyer net `+30` (refund) with a `REFUND` txn, seller `+20`.
11. **guards**: pay someone else's order → `403`; pay a `COMPLETED` order → `400`; `GET /orders/:id` as a third party → `403`; no token → `401`; `POST /scheduler/run` as a non-admin → `403`.
12. **reads**: `GET /orders/mine` (buyer sees theirs), `GET /orders/sales` (seller sees all sales), `GET /orders/:id` returns `counterpart` with the other party's email.

Run: `node scripts/test-orders.mjs`
Expected: `=== N/N passed ===` and exit code 0.

- [ ] **Step 4: Fix any failure and re-run**

A red case means the code is wrong (or the test call is) — fix it, restart the server, re-run. Never report a red case as a known issue without the user agreeing.

- [ ] **Step 5: Report and hand off**

Produce the pass/fail table. If all green, say the module is verified — the commit and push are the user's call.

---

## Notes for the implementer

- **Never run `prisma migrate dev`** — drift on `20260706160744_category_enum` makes it want a DB reset, which would wipe the mobile team's data. Task 1 uses `migrate deploy` on a hand-placed file.
- **`"Order"` is a SQL reserved word** — it must stay double-quoted in every raw query.
- **Emails never fail a transaction** — they are fired after commit and swallowed (`safeMail` / `notifyPaid`), matching the `bids` outbid pattern.
- **Neon cold start:** the first request after idle may be slow or need one retry.
- **The one-minute cron keeps Neon awake** (it queries every tick) — expected and accepted.
