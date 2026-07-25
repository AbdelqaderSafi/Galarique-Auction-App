import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FollowsService } from './follows.service';
import {
  createMockDatabaseService,
  resetMockDatabaseService,
  type MockDatabaseService,
} from '../../test-utils/prisma-mock';

describe('FollowsService', () => {
  let prisma: MockDatabaseService;
  let service: FollowsService;
  const followerId = 'user-1';
  const sellerId = 'seller-1';

  beforeEach(() => {
    prisma = createMockDatabaseService();
    service = new FollowsService(prisma);
  });

  afterEach(() => {
    resetMockDatabaseService(prisma);
    jest.clearAllMocks();
  });

  describe('follow', () => {
    it('rejects following yourself', async () => {
      await expect(service.follow(followerId, followerId)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('throws 404 if the target has no SellerProfile', async () => {
      prisma.user.findUnique.mockResolvedValue({ sellerProfile: null } as any);
      await expect(service.follow(followerId, sellerId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws 404 if the target user does not exist at all', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.follow(followerId, sellerId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('is idempotent: upserts and returns following:true for a verified seller', async () => {
      prisma.user.findUnique.mockResolvedValue({ sellerProfile: { id: 'sp1' } } as any);

      const result = await service.follow(followerId, sellerId);

      expect(prisma.follow.upsert).toHaveBeenCalledWith({
        where: { followerId_sellerId: { followerId, sellerId } },
        create: { followerId, sellerId },
        update: {},
      });
      expect(result).toEqual({ following: true });
    });
  });

  describe('unfollow', () => {
    it('is idempotent: always returns following:false', async () => {
      prisma.follow.deleteMany.mockResolvedValue({ count: 0 } as any);
      const result = await service.unfollow(followerId, sellerId);
      expect(result).toEqual({ following: false });
    });
  });

  describe('listFollowing', () => {
    it('maps rows to the response shape newest-first', async () => {
      prisma.$transaction.mockResolvedValueOnce([
        [{ createdAt: new Date(), seller: { id: sellerId, fullName: 'Seller One' } }],
        1,
      ] as any);

      const result = await service.listFollowing(followerId);

      expect(result.items[0]).toEqual(
        expect.objectContaining({ id: sellerId, fullName: 'Seller One' }),
      );
    });
  });
});
