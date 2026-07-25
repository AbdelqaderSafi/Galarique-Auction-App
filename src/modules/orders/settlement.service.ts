import {
  BadRequestException,
  Injectable,
  Logger,
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
import { RealtimeService } from '../realtime/realtime.service';
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
    private readonly realtime: RealtimeService,
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

  // إنهاء فوري يدوي لمزاد واحد — لاختبار فريق الموبايل بلا انتظار durationDays الحقيقي.
  // بيمرّ بنفس مسار closeOne (UNSOLD/ENDED+Order+إيميلات+realtime) — بس بيتجاوز فحص endTime.
  async forceEndAuction(auctionId: string): Promise<{ auctionId: string; closed: boolean }> {
    const auction = await this.prisma.auction.findUnique({
      where: { id: auctionId },
      select: { status: true },
    });
    if (!auction) throw new NotFoundException('Auction not found');
    if (auction.status !== AuctionStatus.LIVE) {
      throw new BadRequestException('Only a LIVE auction can be force-ended');
    }
    const closed = await this.closeOne(auctionId, true);
    return { auctionId, closed };
  }

  // force=true يتجاوز فحص endTime — للاختبار اليدوي (force-end) فقط، نفس خط الإغلاق تمامًا
  private async closeOne(auctionId: string, force = false): Promise<boolean> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Auction" WHERE id = ${auctionId} FOR UPDATE`;

      const auction = await tx.auction.findUnique({
        where: { id: auctionId },
        include: AUCTION_INCLUDE,
      });
      // نسخة ثانية سبقتنا، أو تمدّد الوقت (anti-snipe) بين الاستعلام والقفل
      if (!auction || auction.status !== AuctionStatus.LIVE) return null;
      if (!auction.endTime) return null;
      if (!force && auction.endTime > new Date()) return null;

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
    });

    if (!outcome) return false;

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
  }

  private async safeMail(send: () => Promise<void>): Promise<void> {
    try {
      await send();
    } catch {
      // البريد لا يُفشِل التسوية
    }
  }

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
