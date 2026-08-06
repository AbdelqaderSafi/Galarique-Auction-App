import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AuctionStatus, Prisma, Role } from 'generated/prisma/client';
import { BidsService } from './bids.service';
import { WalletService } from '../wallet/wallet.service';
import { MailService } from '../mail/mail.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  createMockDatabaseService,
  resetMockDatabaseService,
  type MockDatabaseService,
} from '../../test-utils/prisma-mock';
import type { SafeUser } from 'src/types/declartion-mergin';

describe('BidsService', () => {
  let prisma: MockDatabaseService;
  let wallet: jest.Mocked<WalletService>;
  let mail: jest.Mocked<MailService>;
  let realtime: jest.Mocked<RealtimeService>;
  let service: BidsService;

  const seller: SafeUser = { id: 'seller-1', fullName: 'Seller One' } as SafeUser;
  const bidderA: SafeUser = { id: 'buyer-a', fullName: 'Buyer A' } as SafeUser;
  const bidderB: SafeUser = { id: 'buyer-b', fullName: 'Buyer B' } as SafeUser;

  const baseAuction = {
    id: 'auction-1',
    status: AuctionStatus.LIVE,
    startingPrice: new Prisma.Decimal(100),
    minBidIncrement: new Prisma.Decimal(10),
    currentPrice: new Prisma.Decimal(0),
    currentWinnerId: null as string | null,
    antiSnipeSeconds: 60,
    extendBySeconds: 60,
    objectId: 'object-1',
    object: { ownerId: seller.id, title: 'Vintage Watch' },
    endTime: new Date(Date.now() + 60 * 60 * 1000), // 1h from now
  };

  beforeEach(() => {
    prisma = createMockDatabaseService();
    wallet = { holdBidDeposit: jest.fn(), releaseBidDeposit: jest.fn() } as unknown as jest.Mocked<WalletService>;
    mail = { sendOutbid: jest.fn() } as unknown as jest.Mocked<MailService>;
    realtime = {
      publishBid: jest.fn(),
      publishToUser: jest.fn(),
    } as unknown as jest.Mocked<RealtimeService>;
    service = new BidsService(prisma, wallet, mail, realtime);
  });

  afterEach(() => {
    resetMockDatabaseService(prisma);
    jest.clearAllMocks();
  });

  describe('place', () => {
    it('rejects a bid on a non-existent auction', async () => {
      prisma.auction.findUnique.mockResolvedValue(null);

      await expect(service.place('missing', bidderA, 100)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects a bid when the auction is not LIVE', async () => {
      prisma.auction.findUnique.mockResolvedValue({
        ...baseAuction,
        status: AuctionStatus.ENDED,
      } as any);

      await expect(service.place(baseAuction.id, bidderA, 100)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects a bid placed after endTime even if status is still LIVE', async () => {
      prisma.auction.findUnique.mockResolvedValue({
        ...baseAuction,
        endTime: new Date(Date.now() - 1000),
      } as any);

      await expect(service.place(baseAuction.id, bidderA, 100)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('forbids the owner from bidding on their own auction', async () => {
      prisma.auction.findUnique.mockResolvedValue(baseAuction as any);

      await expect(service.place(baseAuction.id, seller, 100)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rejects the current highest bidder from bidding again', async () => {
      prisma.auction.findUnique.mockResolvedValue({
        ...baseAuction,
        currentWinnerId: bidderA.id,
        currentPrice: new Prisma.Decimal(100),
      } as any);

      await expect(service.place(baseAuction.id, bidderA, 200)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects a first bid below the starting price', async () => {
      prisma.auction.findUnique.mockResolvedValue(baseAuction as any);

      await expect(service.place(baseAuction.id, bidderA, 50)).rejects.toThrow(
        'Minimum bid is $100.00',
      );
      expect(wallet.holdBidDeposit).not.toHaveBeenCalled();
    });

    it('rejects a later bid below currentPrice + the tier increment', async () => {
      prisma.auction.findUnique.mockResolvedValue({
        ...baseAuction,
        currentWinnerId: bidderB.id,
        currentPrice: new Prisma.Decimal(100),
      } as any);

      await expect(service.place(baseAuction.id, bidderA, 105)).rejects.toThrow(
        'Minimum bid is $110.00',
      );
    });

    // العمود نسخة للقراءة قد تتقادم؛ التحقق يجب أن يعتمد على جدول الشرائح وحده
    it('derives the floor from the price tier, ignoring a stale stored minBidIncrement', async () => {
      prisma.auction.findUnique.mockResolvedValue({
        ...baseAuction,
        currentWinnerId: bidderB.id,
        currentPrice: new Prisma.Decimal(30), // شريحة الـ2
        minBidIncrement: new Prisma.Decimal(50), // قيمة قديمة متروكة بالعمود
      } as any);

      // لو قرأ العمود لكانت الأرضية 80؛ الصحيح 30 + 2
      await expect(service.place(baseAuction.id, bidderA, 31)).rejects.toThrow(
        'Minimum bid is $32.00',
      );
    });

    it('applies the tier of the price being raised from, not the new price', async () => {
      prisma.auction.findUnique.mockResolvedValue({
        ...baseAuction,
        currentWinnerId: bidderB.id,
        currentPrice: new Prisma.Decimal(99), // شريحة الـ2 → الأرضية 101
      } as any);
      wallet.holdBidDeposit.mockResolvedValue(true);
      prisma.bid.create.mockResolvedValue({
        id: 'bid-tier',
        amount: new Prisma.Decimal(101),
        createdAt: new Date(),
      } as any);
      prisma.auction.update.mockImplementation((args: any) =>
        Promise.resolve({ ...baseAuction, ...args.data }),
      );
      prisma.user.findUnique.mockResolvedValue({
        email: 'b@test.local',
        fullName: bidderB.fullName,
      } as any);

      await expect(
        service.place(baseAuction.id, bidderA, 100),
      ).rejects.toThrow('Minimum bid is $101.00');

      await expect(
        service.place(baseAuction.id, bidderA, 101),
      ).resolves.toMatchObject({ currentPrice: '101.00' });
    });

    // عبور حدّ الشريحة يجب أن يُحدِّث العمود، وإلا عرض الموبايل زيادة قديمة
    it('rewrites minBidIncrement to the new tier when the bid crosses a boundary', async () => {
      prisma.auction.findUnique.mockResolvedValue({
        ...baseAuction,
        currentWinnerId: bidderB.id,
        currentPrice: new Prisma.Decimal(900), // شريحة الـ10
      } as any);
      wallet.holdBidDeposit.mockResolvedValue(true);
      prisma.bid.create.mockResolvedValue({
        id: 'bid-cross',
        amount: new Prisma.Decimal(1200),
        createdAt: new Date(),
      } as any);
      prisma.auction.update.mockImplementation((args: any) =>
        Promise.resolve({ ...baseAuction, ...args.data }),
      );
      prisma.user.findUnique.mockResolvedValue({
        email: 'b@test.local',
        fullName: bidderB.fullName,
      } as any);

      const result = await service.place(baseAuction.id, bidderA, 1200);

      const updateCall = prisma.auction.update.mock.calls[0][0] as any;
      expect(updateCall.data.minBidIncrement.toNumber()).toBe(50);
      expect(result.minBidIncrement).toBe('50.00');
      expect(realtime.publishBid).toHaveBeenCalledWith(
        baseAuction.id,
        expect.objectContaining({ minBidIncrement: '50.00' }),
      );
    });

    it('accepts a valid first bid: holds a deposit, creates the bid, updates the auction, broadcasts', async () => {
      prisma.auction.findUnique.mockResolvedValue(baseAuction as any);
      wallet.holdBidDeposit.mockResolvedValue(true);
      const createdBid = {
        id: 'bid-1',
        auctionId: baseAuction.id,
        bidderId: bidderA.id,
        amount: new Prisma.Decimal(100),
        createdAt: new Date(),
      };
      prisma.bid.create.mockResolvedValue(createdBid as any);
      const updatedAuction = {
        ...baseAuction,
        currentPrice: new Prisma.Decimal(100),
        currentWinnerId: bidderA.id,
      };
      prisma.auction.update.mockResolvedValue(updatedAuction as any);

      const result = await service.place(baseAuction.id, bidderA, 100);

      expect(wallet.holdBidDeposit).toHaveBeenCalledWith(
        prisma,
        bidderA.id,
        baseAuction.id,
      );
      expect(prisma.bid.create).toHaveBeenCalledWith({
        data: { auctionId: baseAuction.id, bidderId: bidderA.id, amount: expect.any(Prisma.Decimal) },
      });
      expect(wallet.releaseBidDeposit).not.toHaveBeenCalled(); // no previous winner
      expect(result).toEqual({
        bidId: 'bid-1',
        amount: '100.00',
        currentPrice: '100.00',
        minBidIncrement: '10.00',
        endTime: updatedAuction.endTime,
        isHighest: true,
        depositHeld: true,
      });
      expect(realtime.publishBid).toHaveBeenCalledWith(
        baseAuction.id,
        expect.objectContaining({ type: 'bid', amount: '100.00', bidderName: bidderA.fullName }),
      );
      expect(realtime.publishToUser).not.toHaveBeenCalled();
    });

    it('releases the previous winner deposit and emails/broadcasts them when outbid', async () => {
      prisma.auction.findUnique.mockResolvedValue({
        ...baseAuction,
        currentWinnerId: bidderB.id,
        currentPrice: new Prisma.Decimal(100),
      } as any);
      wallet.holdBidDeposit.mockResolvedValue(true);
      prisma.bid.create.mockResolvedValue({
        id: 'bid-2',
        amount: new Prisma.Decimal(150),
        createdAt: new Date(),
      } as any);
      const updatedAuction = {
        ...baseAuction,
        currentPrice: new Prisma.Decimal(150),
        currentWinnerId: bidderA.id,
      };
      prisma.auction.update.mockResolvedValue(updatedAuction as any);
      prisma.user.findUnique.mockResolvedValue({
        email: 'buyerb@test.local',
        fullName: bidderB.fullName,
      } as any);

      const result = await service.place(baseAuction.id, bidderA, 150);

      expect(wallet.releaseBidDeposit).toHaveBeenCalledWith(
        prisma,
        bidderB.id,
        baseAuction.id,
      );
      expect(realtime.publishToUser).toHaveBeenCalledWith(
        bidderB.id,
        expect.objectContaining({ type: 'outbid', auctionId: baseAuction.id, newPrice: '150.00' }),
      );
      expect(result.isHighest).toBe(true);
      // outbid mail is fire-and-forget; flush microtasks then assert
      await new Promise(process.nextTick);
      expect(mail.sendOutbid).toHaveBeenCalledWith(
        'buyerb@test.local',
        bidderB.fullName,
        'Vintage Watch',
        '150.00',
      );
    });

    it('extends endTime (anti-snipe) when the bid lands within antiSnipeSeconds of the close', async () => {
      const almostOver = new Date(Date.now() + 30 * 1000); // 30s left, antiSnipe = 60s
      prisma.auction.findUnique.mockResolvedValue({
        ...baseAuction,
        endTime: almostOver,
      } as any);
      wallet.holdBidDeposit.mockResolvedValue(true);
      prisma.bid.create.mockResolvedValue({
        id: 'bid-3',
        amount: new Prisma.Decimal(100),
        createdAt: new Date(),
      } as any);
      prisma.auction.update.mockImplementation((args: any) =>
        Promise.resolve({ ...baseAuction, ...args.data, currentPrice: new Prisma.Decimal(100) }),
      );

      await service.place(baseAuction.id, bidderA, 100);

      const updateCall = prisma.auction.update.mock.calls[0][0] as any;
      expect(updateCall.data.endTime.getTime()).toBe(
        almostOver.getTime() + baseAuction.extendBySeconds * 1000,
      );
    });

    it('does NOT extend endTime when the bid lands outside the anti-snipe window', async () => {
      prisma.auction.findUnique.mockResolvedValue(baseAuction as any); // 1h left
      wallet.holdBidDeposit.mockResolvedValue(true);
      prisma.bid.create.mockResolvedValue({
        id: 'bid-4',
        amount: new Prisma.Decimal(100),
        createdAt: new Date(),
      } as any);
      prisma.auction.update.mockImplementation((args: any) =>
        Promise.resolve({ ...baseAuction, ...args.data, currentPrice: new Prisma.Decimal(100) }),
      );

      await service.place(baseAuction.id, bidderA, 100);

      const updateCall = prisma.auction.update.mock.calls[0][0] as any;
      expect(updateCall.data.endTime).toBeUndefined();
    });

    it('propagates the insufficient-deposit error from WalletService and never creates a bid', async () => {
      prisma.auction.findUnique.mockResolvedValue(baseAuction as any);
      wallet.holdBidDeposit.mockRejectedValue(
        new BadRequestException('Insufficient balance for the $50 bid deposit.'),
      );

      await expect(service.place(baseAuction.id, bidderA, 100)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.bid.create).not.toHaveBeenCalled();
    });
  });

  describe('getAuctionBids', () => {
    it('throws 404 for a non-public auction status', async () => {
      prisma.auction.findUnique.mockResolvedValue({ status: AuctionStatus.DRAFT } as any);

      await expect(service.getAuctionBids('auction-1')).rejects.toThrow(NotFoundException);
    });

    it('returns bids highest-first with bidder names for a public auction', async () => {
      prisma.auction.findUnique.mockResolvedValue({ status: AuctionStatus.LIVE } as any);
      prisma.$transaction.mockResolvedValueOnce([
        [
          {
            id: 'b2',
            amount: new Prisma.Decimal(200),
            bidder: { fullName: 'Buyer B' },
            createdAt: new Date(),
          },
          {
            id: 'b1',
            amount: new Prisma.Decimal(100),
            bidder: { fullName: 'Buyer A' },
            createdAt: new Date(),
          },
        ],
        2,
      ] as any);

      const result = await service.getAuctionBids('auction-1');

      expect(result.total).toBe(2);
      expect(result.items.map((i) => i.amount)).toEqual(['200.00', '100.00']);
      expect(result.items.every((i) => typeof i.bidderName === 'string')).toBe(true);
    });
  });

  describe('getMyBids', () => {
    it('marks isWinning true only for bids where the caller is the current winner', async () => {
      prisma.$transaction.mockResolvedValueOnce([
        [
          {
            id: 'bid-1',
            amount: new Prisma.Decimal(150),
            createdAt: new Date(),
            auction: {
              id: 'auction-1',
              status: AuctionStatus.LIVE,
              currentPrice: new Prisma.Decimal(150),
              currentWinnerId: bidderA.id,
              object: { title: 'Vintage Watch', mainImage: 'img.jpg' },
            },
          },
        ],
        1,
      ] as any);

      const result = await service.getMyBids(bidderA.id);

      expect(result.items[0].isWinning).toBe(true);
    });
  });
});
