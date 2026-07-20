import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { FollowsResponse, ToggleFollowResponse } from './dto/follows.dto';

@Injectable()
export class FollowsService {
  constructor(private readonly prisma: DatabaseService) {}

  // متابعة بائع — لا يجوز متابعة نفسك، والهدف يجب أن يكون بائعاً موثّقاً — idempotent
  async follow(followerId: string, sellerId: string): Promise<ToggleFollowResponse> {
    if (followerId === sellerId) {
      throw new BadRequestException('You cannot follow yourself');
    }

    const seller = await this.prisma.user.findUnique({
      where: { id: sellerId },
      select: { sellerProfile: { select: { id: true } } },
    });
    if (!seller || !seller.sellerProfile) {
      throw new NotFoundException('Seller not found');
    }

    await this.prisma.follow.upsert({
      where: { followerId_sellerId: { followerId, sellerId } },
      create: { followerId, sellerId },
      update: {},
    });

    return { following: true };
  }

  // إلغاء متابعة بائع — idempotent
  async unfollow(followerId: string, sellerId: string): Promise<ToggleFollowResponse> {
    await this.prisma.follow.deleteMany({ where: { followerId, sellerId } });
    return { following: false };
  }

  // البائعون الذين أتابعهم — الأحدث أولاً
  async listFollowing(
    followerId: string,
    page = 1,
    limit = 20,
  ): Promise<FollowsResponse> {
    const safePage = page > 0 ? page : 1;
    const safeLimit = limit > 0 && limit <= 50 ? limit : 20;

    const where = { followerId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.follow.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
        include: { seller: { select: { id: true, fullName: true } } },
      }),
      this.prisma.follow.count({ where }),
    ]);

    return {
      items: rows.map((f) => ({
        id: f.seller.id,
        fullName: f.seller.fullName,
        followedAt: f.createdAt,
      })),
      page: safePage,
      limit: safeLimit,
      total,
    };
  }
}
