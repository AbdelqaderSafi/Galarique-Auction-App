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
} from 'generated/prisma/client';
import { DatabaseService } from '../database/database.service';
import { MailService } from '../mail/mail.service';
import type { OrderDetail, OrderListItem, OrdersResponse } from './dto/orders.dto';

// العربون الثابت + مهلة الدفع (72 ساعة)
export const DEPOSIT_AMOUNT = new Prisma.Decimal(50);
export const PAYMENT_WINDOW_MS = 72 * 60 * 60 * 1000;

// رسوم شحن ثابتة على المشتري، بتروح للبائع (هو الي بشحن)
export const SHIPPING_FEE = new Prisma.Decimal(20);

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

      // إجمالي ما على المشتري = ثمن القطعة + الشحن
      const totalDue = order.amount.plus(SHIPPING_FEE);

      // العربون أكبر من الإجمالي → رُدّ الفرق للمشتري
      let excess = new Prisma.Decimal(0);
      if (usesDeposit && order.depositApplied.greaterThan(totalDue)) {
        excess = order.depositApplied.minus(totalDue);
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
            note: 'Deposit exceeded the total due',
          },
        });
      }

      // ما خرج فعلياً من جيب المشتري — مشتق من الصف نفسه، مش من إعادة حساب السعر
      const netPaid = order.amountDue.plus(order.depositApplied).minus(excess);

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
          amount: netPaid,
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
        data: { balance: { increment: netPaid } },
      });
      await tx.walletTransaction.create({
        data: {
          walletId: sellerWallet.id,
          type: WalletTxnType.SALE,
          amount: netPaid,
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
