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
import { PUBLIC_STATUSES } from '../auctions/auctions.service';
import type { SafeUser } from 'src/types/declartion-mergin';
import type {
  AuctionBidsResponse,
  MyBidsResponse,
  PlaceBidResponse,
} from './dto/bids.dto';

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
