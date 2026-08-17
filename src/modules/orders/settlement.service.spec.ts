import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  AuctionStatus,
  DepositStatus,
  ObjectStatus,
  OrderStatus,
  Prisma,
  WalletTxnType,
} from 'generated/prisma/client';
import { SettlementService } from './settlement.service';
import { OrdersService } from './orders.service';
import { MailService } from '../mail/mail.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  createMockDatabaseService,
  resetMockDatabaseService,
  type MockDatabaseService,
} from '../../test-utils/prisma-mock';

describe('SettlementService', () => {
  let prisma: MockDatabaseService;
  let orders: jest.Mocked<OrdersService>;
  let mail: jest.Mocked<MailService>;
  let realtime: jest.Mocked<RealtimeService>;
  let service: SettlementService;

  const auctionId = 'auction-1';
  const objectId = 'object-1';
  const sellerId = 'seller-1';
  const winnerId = 'buyer-1';

  const auctionRow = (overrides: Partial<any> = {}) => ({
    id: auctionId,
    objectId,
    status: AuctionStatus.LIVE,
    endTime: new Date(Date.now() - 1000), // already due
    currentWinnerId: winnerId,
    currentPrice: new Prisma.Decimal(200),
    object: {
      id: objectId,
      ownerId: sellerId,
      title: 'Painting',
      owner: { email: 'seller@x.com', fullName: 'Seller' },
    },
    ...overrides,
  });

  beforeEach(() => {
    prisma = createMockDatabaseService();
    orders = { payOrder: jest.fn() } as unknown as jest.Mocked<OrdersService>;
    mail = {
      sendAuctionUnsold: jest.fn(),
      sendPaymentRequired: jest.fn(),
      sendSecondChance: jest.fn(),
    } as unknown as jest.Mocked<MailService>;
    realtime = {
      publishToAuction: jest.fn(),
      publishToUser: jest.fn(),
    } as unknown as jest.Mocked<RealtimeService>;
    service = new SettlementService(prisma, orders, mail, realtime);
  });

  afterEach(() => {
    resetMockDatabaseService(prisma);
    jest.clearAllMocks();
  });

  describe('closeOne (via closeDueAuctions)', () => {
    it('marks a no-bid auction UNSOLD, frees the Object, and never creates an Order', async () => {
      prisma.auction.findMany.mockResolvedValue([{ id: auctionId }] as any);
      prisma.auction.findUnique.mockResolvedValue(auctionRow({ currentWinnerId: null }) as any);

      const closed = await service.closeDueAuctions();

      expect(closed).toBe(1);
      expect(prisma.auction.update).toHaveBeenCalledWith({
        where: { id: auctionId },
        data: { status: AuctionStatus.UNSOLD },
      });
      expect(prisma.object.update).toHaveBeenCalledWith({
        where: { id: objectId },
        data: { status: ObjectStatus.AVAILABLE },
      });
      expect(prisma.order.create).not.toHaveBeenCalled();
      expect(realtime.publishToAuction).toHaveBeenCalledWith(
        auctionId,
        expect.objectContaining({ type: 'closed', status: 'UNSOLD' }),
      );
    });

    it('creates an ENDED auction + AWAITING_PAYMENT Order (rank 1) for a winning auction, then attempts payment', async () => {
      prisma.auction.findMany.mockResolvedValue([{ id: auctionId }] as any);
      prisma.auction.findUnique.mockResolvedValue(auctionRow() as any);
      prisma.order.create.mockResolvedValue({
        id: 'order-1',
        paymentDeadline: new Date(Date.now() + 72 * 60 * 60 * 1000),
      } as any);
      prisma.user.findUnique.mockResolvedValue({ fullName: 'Winner' } as any);
      orders.payOrder.mockResolvedValue({} as any);

      const closed = await service.closeDueAuctions();

      expect(closed).toBe(1);
      expect(prisma.auction.update).toHaveBeenCalledWith({
        where: { id: auctionId },
        data: { status: AuctionStatus.ENDED },
      });
      expect(prisma.order.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          auctionId,
          buyerId: winnerId,
          sellerId,
          amount: new Prisma.Decimal(200),
          depositApplied: new Prisma.Decimal(50),
          amountDue: new Prisma.Decimal(170), // 200 + 20 shipping - 50 deposit
          offerRank: 1,
          status: OrderStatus.AWAITING_PAYMENT,
        }),
      });
      expect(orders.payOrder).toHaveBeenCalledWith('order-1');
      expect(realtime.publishToUser).toHaveBeenCalledWith(
        winnerId,
        expect.objectContaining({ type: 'won', orderId: 'order-1' }),
      );
    });

    it('clamps amountDue to 0 when price + shipping <= the $50 deposit', async () => {
      prisma.auction.findMany.mockResolvedValue([{ id: auctionId }] as any);
      prisma.auction.findUnique.mockResolvedValue(
        auctionRow({ currentPrice: new Prisma.Decimal(30) }) as any,
      );
      prisma.order.create.mockResolvedValue({
        id: 'order-1',
        paymentDeadline: new Date(),
      } as any);
      orders.payOrder.mockResolvedValue({} as any);

      await service.closeDueAuctions();

      // 30 + 20 = 50, exactly the deposit → nothing left to pay
      expect(prisma.order.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ amountDue: new Prisma.Decimal(0) }),
      });
    });

    it('charges the shipping shortfall when the deposit only partly covers price + shipping', async () => {
      prisma.auction.findMany.mockResolvedValue([{ id: auctionId }] as any);
      prisma.auction.findUnique.mockResolvedValue(
        auctionRow({ currentPrice: new Prisma.Decimal(40) }) as any,
      );
      prisma.order.create.mockResolvedValue({
        id: 'order-1',
        paymentDeadline: new Date(),
      } as any);
      orders.payOrder.mockResolvedValue({} as any);

      await service.closeDueAuctions();

      // 40 + 20 - 50 = 10
      expect(prisma.order.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ amountDue: new Prisma.Decimal(10) }),
      });
    });

    it('sends payment-required email when the immediate auto-pay attempt fails (insufficient balance)', async () => {
      prisma.auction.findMany.mockResolvedValue([{ id: auctionId }] as any);
      prisma.auction.findUnique.mockResolvedValue(auctionRow() as any);
      prisma.order.create.mockResolvedValue({
        id: 'order-1',
        paymentDeadline: new Date(),
      } as any);
      orders.payOrder.mockRejectedValue(new BadRequestException('Insufficient balance'));
      prisma.user.findUnique
        .mockResolvedValueOnce({ fullName: 'Winner' } as any) // inside closeOne, for winnerName
        .mockResolvedValueOnce({ email: 'buyer@x.com', fullName: 'Winner' } as any); // outside, for the email

      await service.closeDueAuctions();

      await new Promise(process.nextTick);
      expect(mail.sendPaymentRequired).toHaveBeenCalled();
    });

    it('skips (no-op) an auction that a concurrent tick already moved out of LIVE', async () => {
      prisma.auction.findMany.mockResolvedValue([{ id: auctionId }] as any);
      prisma.auction.findUnique.mockResolvedValue(auctionRow({ status: AuctionStatus.ENDED }) as any);

      const closed = await service.closeDueAuctions();

      expect(closed).toBe(0);
      expect(prisma.auction.update).not.toHaveBeenCalled();
    });

    it('does not let one failing auction stop the batch (logs and continues)', async () => {
      prisma.auction.findMany.mockResolvedValue([{ id: 'a1' }, { id: 'a2' }] as any);
      prisma.auction.findUnique
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(auctionRow({ id: 'a2', currentWinnerId: null }) as any);

      const closed = await service.closeDueAuctions();

      expect(closed).toBe(1);
    });
  });

  describe('forceEndAuction', () => {
    it('throws 404 for an unknown auction', async () => {
      prisma.auction.findUnique.mockResolvedValueOnce(null as any);
      await expect(service.forceEndAuction(auctionId)).rejects.toThrow(NotFoundException);
    });

    it('throws 400 for a non-LIVE auction', async () => {
      prisma.auction.findUnique.mockResolvedValueOnce({ status: AuctionStatus.ENDED } as any);
      await expect(service.forceEndAuction(auctionId)).rejects.toThrow(
        'Only a LIVE auction can be force-ended',
      );
    });

    it('closes a LIVE auction even if endTime is in the future (bypasses the endTime check)', async () => {
      prisma.auction.findUnique
        .mockResolvedValueOnce({ status: AuctionStatus.LIVE } as any) // pre-check
        .mockResolvedValueOnce(
          auctionRow({ currentWinnerId: null, endTime: new Date(Date.now() + 60 * 60 * 1000) }) as any,
        ); // inside closeOne

      const result = await service.forceEndAuction(auctionId);

      expect(result).toEqual({ auctionId, closed: true });
    });
  });

  describe('expireOne (via expirePaymentDeadlines)', () => {
    const dueOrder = (overrides: Partial<any> = {}) => ({
      id: 'order-1',
      auctionId,
      buyerId: winnerId,
      sellerId,
      offerRank: 1,
      status: OrderStatus.AWAITING_PAYMENT,
      paymentDeadline: new Date(Date.now() - 1000),
      auction: {
        objectId,
        object: { title: 'Painting', owner: { email: 'seller@x.com', fullName: 'Seller' } },
      },
      ...overrides,
    });

    it('cancels a lapsed rank-2 (second-chance) offer WITHOUT forfeiting any deposit', async () => {
      prisma.order.findMany.mockResolvedValue([{ id: 'order-1' }] as any);
      prisma.order.findUnique.mockResolvedValue(dueOrder({ offerRank: 2 }) as any);

      const handled = await service.expirePaymentDeadlines();

      expect(handled).toBe(1);
      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'order-1' },
        data: { status: OrderStatus.CANCELLED },
      });
      expect(prisma.auction.update).toHaveBeenCalledWith({
        where: { id: auctionId },
        data: { status: AuctionStatus.UNSOLD },
      });
      expect(prisma.auctionDeposit.updateMany).not.toHaveBeenCalled();
    });

    it('forfeits the $50 deposit for a lapsed rank-1 winner and offers rank-2 to the next bidder', async () => {
      prisma.order.findMany.mockResolvedValue([{ id: 'order-1' }] as any);
      prisma.order.findUnique.mockResolvedValue(dueOrder() as any);
      prisma.auctionDeposit.updateMany.mockResolvedValue({ count: 1 } as any);
      prisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-1' } as any);
      prisma.bid.findFirst.mockResolvedValue({
        bidderId: 'buyer-2',
        amount: new Prisma.Decimal(180),
        bidder: { id: 'buyer-2', email: 'b2@x.com', fullName: 'Buyer Two' },
      } as any);
      prisma.order.create.mockResolvedValue({ paymentDeadline: new Date() } as any);

      const handled = await service.expirePaymentDeadlines();

      expect(handled).toBe(1);
      expect(prisma.auctionDeposit.updateMany).toHaveBeenCalledWith({
        where: { auctionId, userId: winnerId, status: DepositStatus.HELD },
        data: { status: DepositStatus.FORFEITED },
      });
      expect(prisma.wallet.update).toHaveBeenCalledWith({
        where: { id: 'wallet-1' },
        data: { lockedBalance: { decrement: new Prisma.Decimal(50) } },
      });
      expect(prisma.walletTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: WalletTxnType.DEPOSIT_FORFEIT, amount: new Prisma.Decimal(50) }),
        }),
      );
      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'order-1' },
        data: { status: OrderStatus.DEFAULTED },
      });
      // second-chance order: rank 2, no deposit applied, priced at the second bidder's own bid
      expect(prisma.order.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          buyerId: 'buyer-2',
          amount: new Prisma.Decimal(180),
          depositApplied: new Prisma.Decimal(0),
          amountDue: new Prisma.Decimal(200), // 180 + 20 shipping, no deposit to offset
          offerRank: 2,
        }),
      });
    });

    it('falls back to UNSOLD when a rank-1 winner defaults and there is no second bidder', async () => {
      prisma.order.findMany.mockResolvedValue([{ id: 'order-1' }] as any);
      prisma.order.findUnique.mockResolvedValue(dueOrder() as any);
      prisma.auctionDeposit.updateMany.mockResolvedValue({ count: 1 } as any);
      prisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-1' } as any);
      prisma.bid.findFirst.mockResolvedValue(null);

      await service.expirePaymentDeadlines();

      expect(prisma.auction.update).toHaveBeenCalledWith({
        where: { id: auctionId },
        data: { status: AuctionStatus.UNSOLD },
      });
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it('is idempotent: a second pass over an already-resolved order is a no-op', async () => {
      prisma.order.findMany.mockResolvedValue([{ id: 'order-1' }] as any);
      prisma.order.findUnique.mockResolvedValue(dueOrder({ status: OrderStatus.DEFAULTED }) as any);

      const handled = await service.expirePaymentDeadlines();

      expect(handled).toBe(0);
      expect(prisma.order.update).not.toHaveBeenCalled();
    });
  });

  describe('retryWinnerPayments', () => {
    it('only targets offerRank=1 AWAITING_PAYMENT orders still within their deadline', async () => {
      prisma.order.findMany.mockResolvedValue([{ id: 'o1' }, { id: 'o2' }] as any);
      orders.payOrder.mockResolvedValueOnce({} as any).mockRejectedValueOnce(new Error('still broke'));

      const paid = await service.retryWinnerPayments();

      expect(prisma.order.findMany).toHaveBeenCalledWith({
        where: {
          status: OrderStatus.AWAITING_PAYMENT,
          offerRank: 1,
          paymentDeadline: { gt: expect.any(Date) },
        },
        select: { id: true },
      });
      expect(paid).toBe(1); // one succeeded, one still failed silently
    });
  });
});
