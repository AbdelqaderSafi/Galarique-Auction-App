import { NotFoundException } from '@nestjs/common';
import { AuctionStatus, Prisma } from 'generated/prisma/client';
import { FavoritesService } from './favorites.service';
import {
  createMockDatabaseService,
  resetMockDatabaseService,
  type MockDatabaseService,
} from '../../test-utils/prisma-mock';

describe('FavoritesService', () => {
  let prisma: MockDatabaseService;
  let service: FavoritesService;
  const userId = 'user-1';
  const auctionId = 'auction-1';

  beforeEach(() => {
    prisma = createMockDatabaseService();
    service = new FavoritesService(prisma);
  });

  afterEach(() => {
    resetMockDatabaseService(prisma);
    jest.clearAllMocks();
  });

  describe('add', () => {
    it('throws 404 for a non-public (e.g. DRAFT) auction', async () => {
      prisma.auction.findUnique.mockResolvedValue({ status: AuctionStatus.DRAFT } as any);
      await expect(service.add(userId, auctionId)).rejects.toThrow(NotFoundException);
      expect(prisma.favoriteAuction.upsert).not.toHaveBeenCalled();
    });

    it('is idempotent: upserts and returns favorited:true for a LIVE auction', async () => {
      prisma.auction.findUnique.mockResolvedValue({ status: AuctionStatus.LIVE } as any);

      const result = await service.add(userId, auctionId);

      expect(prisma.favoriteAuction.upsert).toHaveBeenCalledWith({
        where: { userId_auctionId: { userId, auctionId } },
        create: { userId, auctionId },
        update: {},
      });
      expect(result).toEqual({ favorited: true });
    });
  });

  describe('remove', () => {
    it('is idempotent: always returns favorited:false, even if nothing was favorited', async () => {
      prisma.favoriteAuction.deleteMany.mockResolvedValue({ count: 0 } as any);
      const result = await service.remove(userId, auctionId);
      expect(result).toEqual({ favorited: false });
    });
  });

  describe('list', () => {
    it('maps rows to the response shape newest-first', async () => {
      prisma.$transaction.mockResolvedValueOnce([
        [
          {
            createdAt: new Date('2026-01-01'),
            auction: {
              id: auctionId,
              status: AuctionStatus.LIVE,
              currentPrice: new Prisma.Decimal(0),
              startingPrice: new Prisma.Decimal(100),
              endTime: new Date('2026-02-01'),
              object: { title: 'Vase', mainImage: 'img.jpg' },
            },
          },
        ],
        1,
      ] as any);

      const result = await service.list(userId);

      expect(result.items[0]).toEqual(
        expect.objectContaining({ id: auctionId, title: 'Vase', currentPrice: '0.00', startingPrice: '100.00' }),
      );
      expect(result.total).toBe(1);
    });
  });
});
