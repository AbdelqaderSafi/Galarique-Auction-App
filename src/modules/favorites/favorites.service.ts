import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { PUBLIC_STATUSES } from '../auctions/auctions.service';
import type { FavoriteAuctionsResponse, ToggleFavoriteResponse } from './dto/favorites.dto';

@Injectable()
export class FavoritesService {
  constructor(private readonly prisma: DatabaseService) {}

  // إضافة مزاد للمفضّلة — فقط لو الحالة عامة (LIVE/ENDED/SOLD) — idempotent
  async add(userId: string, auctionId: string): Promise<ToggleFavoriteResponse> {
    const auction = await this.prisma.auction.findUnique({
      where: { id: auctionId },
      select: { status: true },
    });
    if (!auction || !PUBLIC_STATUSES.includes(auction.status)) {
      throw new NotFoundException('Auction not found');
    }

    await this.prisma.favoriteAuction.upsert({
      where: { userId_auctionId: { userId, auctionId } },
      create: { userId, auctionId },
      update: {},
    });

    return { favorited: true };
  }

  // إزالة مزاد من المفضّلة — idempotent
  async remove(userId: string, auctionId: string): Promise<ToggleFavoriteResponse> {
    await this.prisma.favoriteAuction.deleteMany({ where: { userId, auctionId } });
    return { favorited: false };
  }

  // قائمة المزادات المفضّلة — الأحدث أولاً
  async list(userId: string, page = 1, limit = 20): Promise<FavoriteAuctionsResponse> {
    const safePage = page > 0 ? page : 1;
    const safeLimit = limit > 0 && limit <= 50 ? limit : 20;

    const where = { userId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.favoriteAuction.findMany({
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
              startingPrice: true,
              endTime: true,
              object: { select: { title: true, mainImage: true } },
            },
          },
        },
      }),
      this.prisma.favoriteAuction.count({ where }),
    ]);

    return {
      items: rows.map((f) => ({
        id: f.auction.id,
        title: f.auction.object.title,
        mainImage: f.auction.object.mainImage,
        status: f.auction.status,
        currentPrice: f.auction.currentPrice.toFixed(2),
        startingPrice: f.auction.startingPrice.toFixed(2),
        endTime: f.auction.endTime,
        favoritedAt: f.createdAt,
      })),
      page: safePage,
      limit: safeLimit,
      total,
    };
  }
}
