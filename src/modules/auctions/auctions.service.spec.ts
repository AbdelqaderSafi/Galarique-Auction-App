import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AuctionStatus, ObjectStatus, OrderStatus, Role } from 'generated/prisma/client';
import { AuctionsService, PUBLIC_STATUSES } from './auctions.service';
import { MailService } from '../mail/mail.service';
import { WalletService } from '../wallet/wallet.service';
import {
  createMockDatabaseService,
  resetMockDatabaseService,
  type MockDatabaseService,
} from '../../test-utils/prisma-mock';
import type { SafeUser } from 'src/types/declartion-mergin';

describe('AuctionsService', () => {
  let prisma: MockDatabaseService;
  let mail: jest.Mocked<MailService>;
  let wallet: jest.Mocked<WalletService>;
  let service: AuctionsService;

  const owner: SafeUser = { id: 'seller-1', roles: [Role.SELLER] } as SafeUser;
  const otherUser: SafeUser = { id: 'other-1', roles: [Role.BUYER] } as SafeUser;
  const admin: SafeUser = { id: 'admin-1', roles: [Role.ADMIN] } as SafeUser;

  beforeEach(() => {
    prisma = createMockDatabaseService();
    mail = {
      sendAuctionApproved: jest.fn(),
      sendAuctionRejected: jest.fn(),
    } as unknown as jest.Mocked<MailService>;
    wallet = {
      releaseBidDeposit: jest.fn(),
    } as unknown as jest.Mocked<WalletService>;
    service = new AuctionsService(prisma, mail, wallet);
  });

  afterEach(() => {
    resetMockDatabaseService(prisma);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('creates the Object + Auction as PENDING_REVIEW/IN_AUCTION when saveAsDraft is falsy', async () => {
      prisma.object.create.mockResolvedValue({ id: 'object-1' } as any);
      prisma.auction.create.mockResolvedValue({ id: 'auction-1', status: AuctionStatus.PENDING_REVIEW } as any);

      await service.create(owner.id, {
        title: 'Vase',
        category: 'ART',
        startingPrice: 100,
        durationDays: 7,
      } as any);

      expect(prisma.object.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ ownerId: owner.id, status: ObjectStatus.IN_AUCTION }) }),
      );
      expect(prisma.auction.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: AuctionStatus.PENDING_REVIEW }) }),
      );
    });

    // minBidIncrement يأتي من جدول الشرائح حسب سعر الافتتاح — لا من العميل،
    // حتى لو تسلّل في الـ dto، وإلا صار البائع قادراً على تحديده
    it('seeds minBidIncrement from the startingPrice tier, ignoring any client value', async () => {
      prisma.object.create.mockResolvedValue({ id: 'object-1' } as any);
      prisma.auction.create.mockResolvedValue({ id: 'auction-1' } as any);

      await service.create(owner.id, {
        title: 'Vase',
        category: 'ART',
        startingPrice: 100,
        durationDays: 7,
        minBidIncrement: 999,
      } as any);

      const data = prisma.auction.create.mock.calls[0][0].data as any;
      expect(data.minBidIncrement.toNumber()).toBe(10); // شريحة الـ100
    });

    it.each([
      [10, 1],
      [25, 2],
      [500, 10],
      [2500, 50],
    ])(
      'opens an auction started at $%p in the $%p increment tier',
      async (startingPrice, expected) => {
        prisma.object.create.mockResolvedValue({ id: 'object-1' } as any);
        prisma.auction.create.mockResolvedValue({ id: 'auction-1' } as any);

        await service.create(owner.id, {
          title: 'Vase',
          category: 'ART',
          startingPrice,
          durationDays: 7,
        } as any);

        const data = prisma.auction.create.mock.calls[0][0].data as any;
        expect(data.minBidIncrement.toNumber()).toBe(expected);
      },
    );

    it('passes the seller-defined customFields through to the Object', async () => {
      prisma.object.create.mockResolvedValue({ id: 'object-1' } as any);
      prisma.auction.create.mockResolvedValue({ id: 'auction-1' } as any);

      const customFields = [{ label: 'Artist', value: 'Van Gogh' }];
      await service.create(owner.id, {
        title: 'Vase',
        category: 'ART',
        startingPrice: 100,
        durationDays: 7,
        customFields,
      } as any);

      expect(prisma.object.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ customFields }) }),
      );
    });

    it('creates as DRAFT/DRAFT when saveAsDraft is true', async () => {
      prisma.object.create.mockResolvedValue({ id: 'object-1' } as any);
      prisma.auction.create.mockResolvedValue({ id: 'auction-1', status: AuctionStatus.DRAFT } as any);

      await service.create(owner.id, {
        title: 'Vase',
        category: 'ART',
        startingPrice: 100,
        durationDays: 7,
        saveAsDraft: true,
      } as any);

      expect(prisma.object.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: ObjectStatus.DRAFT }) }),
      );
      expect(prisma.auction.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: AuctionStatus.DRAFT }) }),
      );
    });
  });

  describe('update', () => {
    it('throws 404 for a missing auction', async () => {
      prisma.auction.findUnique.mockResolvedValue(null);
      await expect(service.update('a1', owner, {} as any)).rejects.toThrow(NotFoundException);
    });

    it('forbids a non-owner, non-admin from editing', async () => {
      prisma.auction.findUnique.mockResolvedValue({
        status: AuctionStatus.DRAFT,
        object: { ownerId: owner.id },
      } as any);
      await expect(service.update('a1', otherUser, {} as any)).rejects.toThrow(ForbiddenException);
    });

    it('allows an admin to edit regardless of ownership', async () => {
      prisma.auction.findUnique.mockResolvedValue({
        status: AuctionStatus.DRAFT,
        objectId: 'object-1',
        object: { ownerId: owner.id },
      } as any);
      prisma.auction.update.mockResolvedValue({ id: 'a1' } as any);

      await expect(service.update('a1', admin, { startingPrice: 200 } as any)).resolves.toBeDefined();
    });

    it('rejects editing an auction that is LIVE (not in an editable status)', async () => {
      prisma.auction.findUnique.mockResolvedValue({
        status: AuctionStatus.LIVE,
        object: { ownerId: owner.id },
      } as any);
      await expect(service.update('a1', owner, {} as any)).rejects.toThrow(
        'This auction can no longer be edited',
      );
    });

    it('auto-resubmits a REJECTED auction to PENDING_REVIEW and clears the rejection reason', async () => {
      prisma.auction.findUnique.mockResolvedValue({
        status: AuctionStatus.REJECTED,
        objectId: 'object-1',
        object: { ownerId: owner.id },
      } as any);
      prisma.auction.update.mockResolvedValue({ id: 'a1', status: AuctionStatus.PENDING_REVIEW } as any);

      await service.update('a1', owner, { startingPrice: 150 } as any);

      expect(prisma.auction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: AuctionStatus.PENDING_REVIEW,
            rejectionReason: null,
            reviewedById: null,
            reviewedAt: null,
          }),
        }),
      );
    });

    it('replaces customFields on the Object and never writes minBidIncrement', async () => {
      prisma.auction.findUnique.mockResolvedValue({
        status: AuctionStatus.DRAFT,
        objectId: 'object-1',
        object: { ownerId: owner.id },
      } as any);
      prisma.object.update.mockResolvedValue({ id: 'object-1' } as any);
      prisma.auction.update.mockResolvedValue({ id: 'a1' } as any);

      const customFields = [{ label: 'Signature', value: 'Bottom right' }];
      await service.update('a1', owner, { customFields, minBidIncrement: 999 } as any);

      expect(prisma.object.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ customFields }) }),
      );
      // لم يتغيّر سعر الافتتاح → لا سبب لإعادة كتابة الشريحة، وقيمة العميل تُتجاهَل
      const data = prisma.auction.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data).not.toHaveProperty('minBidIncrement');
    });

    // تغيير سعر الافتتاح قبل الإطلاق قد ينقل المزاد لشريحة أخرى
    it('re-seeds the increment tier when startingPrice changes', async () => {
      prisma.auction.findUnique.mockResolvedValue({
        status: AuctionStatus.DRAFT,
        objectId: 'object-1',
        object: { ownerId: owner.id },
      } as any);
      prisma.auction.update.mockResolvedValue({ id: 'a1' } as any);

      await service.update('a1', owner, { startingPrice: 3000 } as any);

      const data = prisma.auction.update.mock.calls[0][0].data as any;
      expect(data.minBidIncrement.toNumber()).toBe(50);
    });

    it('clears customFields when an empty array is sent', async () => {
      prisma.auction.findUnique.mockResolvedValue({
        status: AuctionStatus.DRAFT,
        objectId: 'object-1',
        object: { ownerId: owner.id },
      } as any);
      prisma.object.update.mockResolvedValue({ id: 'object-1' } as any);
      prisma.auction.update.mockResolvedValue({ id: 'a1' } as any);

      await service.update('a1', owner, { customFields: [] } as any);

      expect(prisma.object.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ customFields: [] }) }),
      );
    });
  });

  describe('submit', () => {
    it('rejects submitting a non-DRAFT auction', async () => {
      prisma.auction.findUnique.mockResolvedValue({
        status: AuctionStatus.PENDING_REVIEW,
        object: { ownerId: owner.id },
      } as any);
      await expect(service.submit('a1', owner)).rejects.toThrow(
        'Only draft auctions can be submitted',
      );
    });

    it('moves DRAFT -> PENDING_REVIEW and Object -> IN_AUCTION', async () => {
      prisma.auction.findUnique.mockResolvedValue({
        status: AuctionStatus.DRAFT,
        objectId: 'object-1',
        object: { ownerId: owner.id },
      } as any);
      prisma.auction.update.mockResolvedValue({ id: 'a1', status: AuctionStatus.PENDING_REVIEW } as any);

      await service.submit('a1', owner);

      expect(prisma.object.update).toHaveBeenCalledWith({
        where: { id: 'object-1' },
        data: { status: ObjectStatus.IN_AUCTION },
      });
      expect(prisma.auction.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: AuctionStatus.PENDING_REVIEW } }),
      );
    });
  });

  describe('remove', () => {
    it('rejects deleting a non-DRAFT auction', async () => {
      prisma.auction.findUnique.mockResolvedValue({
        status: AuctionStatus.PENDING_REVIEW,
        object: { ownerId: owner.id },
      } as any);
      await expect(service.remove('a1', owner)).rejects.toThrow(
        'Only draft auctions can be deleted',
      );
    });

    it('deletes both the Auction and its Object for a DRAFT', async () => {
      prisma.auction.findUnique.mockResolvedValue({
        status: AuctionStatus.DRAFT,
        objectId: 'object-1',
        object: { ownerId: owner.id },
      } as any);

      await service.remove('a1', owner);

      expect(prisma.auction.delete).toHaveBeenCalledWith({ where: { id: 'a1' } });
      expect(prisma.object.delete).toHaveBeenCalledWith({ where: { id: 'object-1' } });
    });
  });

  describe('cancel', () => {
    // الإلغاء صار يقرأ المزاد مرّتين: مرّة للتفويض ومرّة داخل الـ transaction بعد القفل
    const mockAuctionForCancel = (status: AuctionStatus, held: string[] = []) => {
      prisma.auction.findUnique.mockResolvedValue({
        status,
        objectId: 'object-1',
        object: { ownerId: owner.id },
      } as any);
      prisma.auctionDeposit.findMany.mockResolvedValue(
        held.map((userId) => ({ userId })) as any,
      );
      prisma.auction.update.mockResolvedValue({ status: AuctionStatus.CANCELLED } as any);
    };

    it('allows the seller to cancel a PENDING_REVIEW auction', async () => {
      mockAuctionForCancel(AuctionStatus.PENDING_REVIEW);

      await expect(service.cancel('a1', owner)).resolves.toBeDefined();
    });

    it('releases every still-HELD deposit so no $50 is stranded in lockedBalance', async () => {
      mockAuctionForCancel(AuctionStatus.LIVE, ['leader-1']);

      await service.cancel('a1', admin);

      // ملاحظة: نفحص الوسائط عبر mock.calls لأن expect.anything() يفشل مع
      // بروكسي jest-mock-extended (يولّد asymmetricMatch تلقائياً فيُفسَّر كـ matcher)
      expect(wallet.releaseBidDeposit).toHaveBeenCalledTimes(1);
      const [txArg, userIdArg, auctionIdArg] =
        wallet.releaseBidDeposit.mock.calls[0];
      expect(txArg).toBeDefined(); // مرّرنا الـ tx لا العميل العام
      expect(userIdArg).toBe('leader-1');
      expect(auctionIdArg).toBe('a1');
    });

    it('cancels any open AWAITING_PAYMENT order so the scheduler cannot charge the buyer afterwards', async () => {
      mockAuctionForCancel(AuctionStatus.ENDED);

      await service.cancel('a1', admin);

      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { auctionId: 'a1', status: OrderStatus.AWAITING_PAYMENT },
        data: { status: OrderStatus.CANCELLED },
      });
    });

    it('forbids the seller from cancelling a LIVE auction (only admin can)', async () => {
      prisma.auction.findUnique.mockResolvedValue({
        status: AuctionStatus.LIVE,
        object: { ownerId: owner.id },
      } as any);
      await expect(service.cancel('a1', owner)).rejects.toThrow(
        'This auction cannot be cancelled',
      );
    });

    it('allows an admin to cancel a LIVE auction', async () => {
      mockAuctionForCancel(AuctionStatus.LIVE);

      await expect(service.cancel('a1', admin)).resolves.toBeDefined();
    });

    it('forbids anyone from cancelling a SOLD auction, even an admin', async () => {
      prisma.auction.findUnique.mockResolvedValue({
        status: AuctionStatus.SOLD,
        object: { ownerId: owner.id },
      } as any);
      await expect(service.cancel('a1', admin)).rejects.toThrow(
        'This auction cannot be cancelled',
      );
    });

    it('forbids a stranger (not owner, not admin) from cancelling', async () => {
      prisma.auction.findUnique.mockResolvedValue({
        status: AuctionStatus.PENDING_REVIEW,
        object: { ownerId: owner.id },
      } as any);
      await expect(service.cancel('a1', otherUser)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('findPublic', () => {
    it('throws 404 for a DRAFT auction (not a public status)', async () => {
      prisma.auction.findUnique.mockResolvedValue({ status: AuctionStatus.DRAFT } as any);
      await expect(service.findPublic('a1')).rejects.toThrow(NotFoundException);
    });

    it('increments viewsCount and returns bidCount for a LIVE auction', async () => {
      prisma.auction.findUnique.mockResolvedValue({
        status: AuctionStatus.LIVE,
        viewsCount: 5,
        _count: { bids: 3 },
      } as any);

      const result = await service.findPublic('a1');

      expect(prisma.auction.update).toHaveBeenCalledWith({
        where: { id: 'a1' },
        data: { viewsCount: { increment: 1 } },
      });
      expect(result.viewsCount).toBe(6);
      expect(result.bidCount).toBe(3);
    });
  });

  describe('approve / reject', () => {
    it('rejects approving a non-PENDING_REVIEW auction', async () => {
      prisma.auction.findUnique.mockResolvedValue({
        status: AuctionStatus.DRAFT,
        object: { owner: {} },
      } as any);
      await expect(service.approve('a1', admin.id)).rejects.toThrow(
        'Only pending auctions can be approved',
      );
    });

    it('approves: sets LIVE with startTime=now and endTime=now+durationDays, and emails the seller', async () => {
      prisma.auction.findUnique.mockResolvedValue({
        status: AuctionStatus.PENDING_REVIEW,
        durationDays: 3,
        object: { title: 'Vase', owner: { email: 'seller@x.com', fullName: 'Seller' } },
      } as any);
      prisma.auction.update.mockImplementation((args: any) => Promise.resolve({ id: 'a1', ...args.data }));

      const result = await service.approve('a1', admin.id);

      const call = prisma.auction.update.mock.calls[0][0] as any;
      const diffDays = (call.data.endTime.getTime() - call.data.startTime.getTime()) / (24 * 60 * 60 * 1000);
      expect(diffDays).toBeCloseTo(3);
      expect(call.data.status).toBe(AuctionStatus.LIVE);
      expect(mail.sendAuctionApproved).toHaveBeenCalledWith('seller@x.com', 'Seller', 'Vase');
    });

    it('rejects: sets REJECTED with a reason and emails the seller', async () => {
      prisma.auction.findUnique.mockResolvedValue({
        status: AuctionStatus.PENDING_REVIEW,
        object: { title: 'Vase', owner: { email: 'seller@x.com', fullName: 'Seller' } },
      } as any);
      prisma.auction.update.mockResolvedValue({ id: 'a1', status: AuctionStatus.REJECTED } as any);

      await service.reject('a1', admin.id, 'Blurry photos');

      expect(prisma.auction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: AuctionStatus.REJECTED, rejectionReason: 'Blurry photos' }),
        }),
      );
      expect(mail.sendAuctionRejected).toHaveBeenCalledWith('seller@x.com', 'Seller', 'Vase', 'Blurry photos');
    });
  });

  describe('browse', () => {
    it('only ever queries LIVE auctions, applying category/search filters', async () => {
      prisma.auction.findMany.mockResolvedValue([] as any);
      prisma.auction.count.mockResolvedValue(0);

      await service.browse({ category: 'ART', q: 'vase', page: 1, limit: 10 } as any);

      expect(prisma.auction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: AuctionStatus.LIVE,
            endTime: { gt: expect.any(Date) },
            object: { category: 'ART', title: { contains: 'vase', mode: 'insensitive' } },
          },
        }),
      );
    });

    it('defaults to sorting by soonest-ending with no filters when the query is empty', async () => {
      prisma.auction.findMany.mockResolvedValue([] as any);
      prisma.auction.count.mockResolvedValue(0);

      await service.browse({} as any);

      expect(prisma.auction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: AuctionStatus.LIVE, endTime: { gt: expect.any(Date) } },
          orderBy: [{ endTime: 'asc' }],
        }),
      );
    });

    // المزاد الذي انتهى وقته يبقى LIVE حتى ينفّذ السكدولر — وخلالها تُرفض المزايدة عليه،
    // فلا يجوز أن يظهر في قائمة "المزادات القائمة"
    it('excludes an auction whose endTime has already passed even though its status is still LIVE', async () => {
      prisma.auction.findMany.mockResolvedValue([] as any);
      prisma.auction.count.mockResolvedValue(0);

      const before = Date.now();
      await service.browse({} as any);
      const after = Date.now();

      const where = (prisma.auction.findMany.mock.calls[0][0] as any).where;
      const cutoff = (where.endTime.gt as Date).getTime();
      expect(cutoff).toBeGreaterThanOrEqual(before);
      expect(cutoff).toBeLessThanOrEqual(after);
    });

    it('returns sellerName on every auction without exposing the nested owner', async () => {
      prisma.auction.findMany.mockResolvedValue([
        {
          id: 'a1',
          object: {
            id: 'object-1',
            owner: { fullName: 'Seller One' },
            images: [],
          },
        },
      ] as any);
      prisma.auction.count.mockResolvedValue(1);

      const result = await service.browse({} as any);

      expect(result.items[0]).toEqual(
        expect.objectContaining({ id: 'a1', sellerName: 'Seller One' }),
      );
      expect('owner' in result.items[0].object).toBe(false);
    });
  });

  describe('findBySeller', () => {
    it('returns sellerName on every auction without exposing the nested owner', async () => {
      prisma.auction.findMany.mockResolvedValue([
        {
          id: 'a1',
          object: {
            id: 'object-1',
            owner: { fullName: 'Seller One' },
            images: [],
          },
        },
      ] as any);
      prisma.auction.count.mockResolvedValue(1);

      const result = await service.findBySeller('seller-1', {});

      expect(result.items[0]).toEqual(
        expect.objectContaining({ id: 'a1', sellerName: 'Seller One' }),
      );
      expect('owner' in result.items[0].object).toBe(false);
    });

    it('filters by ownerId + public statuses only, newest first, with default pagination', async () => {
      prisma.auction.findMany.mockResolvedValue([] as any);
      prisma.auction.count.mockResolvedValue(0);

      const result = await service.findBySeller('seller-1', {} as any);

      expect(prisma.auction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: { in: PUBLIC_STATUSES }, object: { ownerId: 'seller-1' } },
          orderBy: { createdAt: 'desc' },
          skip: 0,
          take: 20,
        }),
      );
      expect(result).toEqual({ items: [], total: 0, page: 1, limit: 20 });
    });

    it('never leaks DRAFT/PENDING_REVIEW/REJECTED/CANCELLED auctions (only public statuses)', async () => {
      prisma.auction.findMany.mockResolvedValue([] as any);
      prisma.auction.count.mockResolvedValue(0);

      await service.findBySeller('seller-1', {} as any);

      const call = prisma.auction.findMany.mock.calls[0][0] as any;
      expect(call.where.status.in).not.toContain(AuctionStatus.DRAFT);
      expect(call.where.status.in).not.toContain(AuctionStatus.PENDING_REVIEW);
      expect(call.where.status.in).not.toContain(AuctionStatus.REJECTED);
      expect(call.where.status.in).not.toContain(AuctionStatus.CANCELLED);
    });

    it('applies custom page/limit as skip/take and echoes them back', async () => {
      prisma.auction.findMany.mockResolvedValue([
        {
          id: 'a1',
          object: {
            id: 'object-1',
            owner: { fullName: 'Seller One' },
            images: [],
          },
        },
      ] as any);
      prisma.auction.count.mockResolvedValue(25);

      const result = await service.findBySeller('seller-1', {
        page: 3,
        limit: 5,
      });

      expect(prisma.auction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 5 }),
      );
      expect(result).toEqual({
        items: [
          {
            id: 'a1',
            object: { id: 'object-1', images: [] },
            sellerName: 'Seller One',
          },
        ],
        total: 25,
        page: 3,
        limit: 5,
      });
    });

    it('returns an empty list (not a 404) for a seller with no public auctions', async () => {
      prisma.auction.findMany.mockResolvedValue([] as any);
      prisma.auction.count.mockResolvedValue(0);

      const result = await service.findBySeller('unknown-seller', {} as any);

      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });
  });
});
