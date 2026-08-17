import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  AuctionStatus,
  DepositStatus,
  ObjectStatus,
  OrderStatus,
  Prisma,
  WalletTxnType,
} from 'generated/prisma/client';
import { OrdersService } from './orders.service';
import { MailService } from '../mail/mail.service';
import {
  createMockDatabaseService,
  resetMockDatabaseService,
  type MockDatabaseService,
} from '../../test-utils/prisma-mock';

describe('OrdersService', () => {
  let prisma: MockDatabaseService;
  let mail: jest.Mocked<MailService>;
  let service: OrdersService;

  const buyerId = 'buyer-1';
  const sellerId = 'seller-1';
  const orderId = 'order-1';

  const baseOrder = {
    id: orderId,
    buyerId,
    sellerId,
    auctionId: 'auction-1',
    amount: new Prisma.Decimal(200),
    depositApplied: new Prisma.Decimal(50),
    amountDue: new Prisma.Decimal(170), // 200 + 20 shipping - 50 deposit
    offerRank: 1,
    status: OrderStatus.AWAITING_PAYMENT,
    paymentDeadline: new Date(Date.now() + 60 * 60 * 1000),
    paidAt: null,
    createdAt: new Date(),
    auction: { id: 'auction-1', objectId: 'object-1', object: { title: 'Painting', mainImage: 'img.jpg' } },
  };

  beforeEach(() => {
    prisma = createMockDatabaseService();
    mail = { sendOrderPaid: jest.fn(), sendItemSold: jest.fn() } as unknown as jest.Mocked<MailService>;
    service = new OrdersService(prisma, mail);
  });

  afterEach(() => {
    resetMockDatabaseService(prisma);
    jest.clearAllMocks();
  });

  describe('payOrder', () => {
    it('throws 404 when the order does not exist', async () => {
      prisma.order.findUnique.mockResolvedValue(null);

      await expect(service.payOrder(orderId)).rejects.toThrow(NotFoundException);
    });

    it('throws 403 when actingUserId does not own the order (endpoint path only)', async () => {
      prisma.order.findUnique.mockResolvedValue(baseOrder as any);

      await expect(service.payOrder(orderId, 'someone-else')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('does NOT check ownership for internal callers (no actingUserId, e.g. scheduler)', async () => {
      prisma.order.findUnique.mockResolvedValue(baseOrder as any);
      prisma.wallet.upsert.mockResolvedValue({ id: 'buyer-wallet' } as any);
      prisma.wallet.updateMany.mockResolvedValue({ count: 1 } as any);
      prisma.order.update.mockResolvedValue(baseOrder as any);

      await expect(service.payOrder(orderId)).resolves.toBeDefined();
    });

    it('rejects when the order is not AWAITING_PAYMENT', async () => {
      prisma.order.findUnique.mockResolvedValue({ ...baseOrder, status: OrderStatus.COMPLETED } as any);

      await expect(service.payOrder(orderId, buyerId)).rejects.toThrow(
        'This order is not awaiting payment',
      );
    });

    it('rejects when the payment deadline has passed', async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...baseOrder,
        paymentDeadline: new Date(Date.now() - 1000),
      } as any);

      await expect(service.payOrder(orderId, buyerId)).rejects.toThrow(
        'The payment deadline has passed',
      );
    });

    it('rejects with insufficient balance and makes no wallet changes', async () => {
      prisma.order.findUnique.mockResolvedValue(baseOrder as any);
      prisma.wallet.upsert.mockResolvedValue({ id: 'buyer-wallet' } as any);
      prisma.wallet.updateMany.mockResolvedValue({ count: 0 } as any);
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({ balance: new Prisma.Decimal(10) } as any);

      await expect(service.payOrder(orderId, buyerId)).rejects.toThrow(
        /Insufficient balance. Needed: \$170\.00, available: \$10\.00/,
      );
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it('happy path: debits amountDue, applies the deposit, credits the seller price + shipping, marks COMPLETED/SOLD', async () => {
      prisma.order.findUnique.mockResolvedValue(baseOrder as any);
      prisma.wallet.upsert.mockImplementation((args: any) =>
        Promise.resolve({ id: args.where.userId === buyerId ? 'buyer-wallet' : 'seller-wallet' } as any),
      );
      prisma.wallet.updateMany.mockResolvedValue({ count: 1 } as any);
      const completedOrder = { ...baseOrder, status: OrderStatus.COMPLETED, paidAt: new Date(), completedAt: new Date() };
      prisma.order.update.mockResolvedValue(completedOrder as any);

      const result = await service.payOrder(orderId, buyerId);

      // buyer debited amountDue, deposit released from lockedBalance
      expect(prisma.wallet.updateMany).toHaveBeenCalledWith({
        where: { id: 'buyer-wallet', balance: { gte: baseOrder.amountDue } },
        data: {
          balance: { decrement: baseOrder.amountDue },
          lockedBalance: { decrement: baseOrder.depositApplied },
        },
      });
      // deposit marked APPLIED
      expect(prisma.auctionDeposit.updateMany).toHaveBeenCalledWith({
        where: { auctionId: baseOrder.auctionId, userId: buyerId, status: DepositStatus.HELD },
        data: { status: DepositStatus.APPLIED },
      });
      // buyer ledger: everything that left the wallet (170 due + 50 deposit)
      expect(prisma.walletTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ walletId: 'buyer-wallet', type: WalletTxnType.PURCHASE, amount: new Prisma.Decimal(220) }),
        }),
      );
      // seller credited price + shipping immediately, no escrow
      expect(prisma.wallet.update).toHaveBeenCalledWith({
        where: { id: 'seller-wallet' },
        data: { balance: { increment: new Prisma.Decimal(220) } },
      });
      expect(prisma.walletTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ walletId: 'seller-wallet', type: WalletTxnType.SALE, amount: new Prisma.Decimal(220) }),
        }),
      );
      // auction SOLD, object SOLD
      expect(prisma.auction.update).toHaveBeenCalledWith({
        where: { id: baseOrder.auctionId },
        data: { status: AuctionStatus.SOLD },
      });
      expect(prisma.object.update).toHaveBeenCalledWith({
        where: { id: 'object-1' },
        data: { status: ObjectStatus.SOLD },
      });
      expect(result.status).toBe(OrderStatus.COMPLETED);
    });

    it('refunds the excess when the deposit exceeds price + shipping (price $25)', async () => {
      const cheapOrder = {
        ...baseOrder,
        amount: new Prisma.Decimal(25),
        depositApplied: new Prisma.Decimal(50),
        amountDue: new Prisma.Decimal(0),
      };
      prisma.order.findUnique.mockResolvedValue(cheapOrder as any);
      prisma.wallet.upsert.mockImplementation((args: any) =>
        Promise.resolve({ id: args.where.userId === buyerId ? 'buyer-wallet' : 'seller-wallet' } as any),
      );
      prisma.wallet.updateMany.mockResolvedValue({ count: 1 } as any);
      prisma.order.update.mockResolvedValue({ ...cheapOrder, status: OrderStatus.COMPLETED } as any);

      await service.payOrder(orderId, buyerId);

      // 50 deposit - (25 + 20) = 5 back to the buyer
      expect(prisma.wallet.update).toHaveBeenCalledWith({
        where: { id: 'buyer-wallet' },
        data: { balance: { increment: new Prisma.Decimal(5) } },
      });
      expect(prisma.walletTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: WalletTxnType.REFUND, amount: new Prisma.Decimal(5) }),
        }),
      );
      // seller nets 0 + 50 - 5 = 45 = 25 + 20 shipping
      expect(prisma.wallet.update).toHaveBeenCalledWith({
        where: { id: 'seller-wallet' },
        data: { balance: { increment: new Prisma.Decimal(45) } },
      });
    });

    it('does not touch auctionDeposit or lockedBalance for a second-chance order (depositApplied = 0)', async () => {
      const secondChanceOrder = {
        ...baseOrder,
        offerRank: 2,
        depositApplied: new Prisma.Decimal(0),
        amountDue: new Prisma.Decimal(220), // 200 + 20 shipping, no deposit
      };
      prisma.order.findUnique.mockResolvedValue(secondChanceOrder as any);
      prisma.wallet.upsert.mockImplementation((args: any) =>
        Promise.resolve({ id: args.where.userId === buyerId ? 'buyer-wallet' : 'seller-wallet' } as any),
      );
      prisma.wallet.updateMany.mockResolvedValue({ count: 1 } as any);
      prisma.order.update.mockResolvedValue({ ...secondChanceOrder, status: OrderStatus.COMPLETED } as any);

      await service.payOrder(orderId, buyerId);

      expect(prisma.wallet.updateMany).toHaveBeenCalledWith({
        where: { id: 'buyer-wallet', balance: { gte: secondChanceOrder.amountDue } },
        data: { balance: { decrement: secondChanceOrder.amountDue } }, // no lockedBalance key
      });
      expect(prisma.auctionDeposit.updateMany).not.toHaveBeenCalled();
    });

    it('credits the seller the money that actually moved, not a recomputed price', async () => {
      // A row whose amountDue + depositApplied deliberately does NOT equal `amount`,
      // proving the credit is derived from the row and not from `order.amount`.
      const oddOrder = {
        ...baseOrder,
        amount: new Prisma.Decimal(999),
        depositApplied: new Prisma.Decimal(50),
        amountDue: new Prisma.Decimal(150),
      };
      prisma.order.findUnique.mockResolvedValue(oddOrder as any);
      prisma.wallet.upsert.mockImplementation((args: any) =>
        Promise.resolve({ id: args.where.userId === buyerId ? 'buyer-wallet' : 'seller-wallet' } as any),
      );
      prisma.wallet.updateMany.mockResolvedValue({ count: 1 } as any);
      prisma.order.update.mockResolvedValue({ ...oddOrder, status: OrderStatus.COMPLETED } as any);

      await service.payOrder(orderId, buyerId);

      expect(prisma.wallet.update).toHaveBeenCalledWith({
        where: { id: 'seller-wallet' },
        data: { balance: { increment: new Prisma.Decimal(200) } }, // 150 + 50, not 999
      });
      expect(prisma.walletTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            walletId: 'seller-wallet',
            type: WalletTxnType.SALE,
            amount: new Prisma.Decimal(200),
          }),
        }),
      );
    });

    it('settles a pre-fee legacy row at its original numbers (no invented $20)', async () => {
      // Created before the shipping fee existed: amountDue = amount - deposit, no fee inside.
      const legacyOrder = {
        ...baseOrder,
        amount: new Prisma.Decimal(200),
        depositApplied: new Prisma.Decimal(50),
        amountDue: new Prisma.Decimal(150),
      };
      prisma.order.findUnique.mockResolvedValue(legacyOrder as any);
      prisma.wallet.upsert.mockImplementation((args: any) =>
        Promise.resolve({ id: args.where.userId === buyerId ? 'buyer-wallet' : 'seller-wallet' } as any),
      );
      prisma.wallet.updateMany.mockResolvedValue({ count: 1 } as any);
      prisma.order.update.mockResolvedValue({ ...legacyOrder, status: OrderStatus.COMPLETED } as any);

      await service.payOrder(orderId, buyerId);

      // 150 + 50 = 200 — exactly what the buyer paid, no fee conjured out of nowhere
      expect(prisma.wallet.update).toHaveBeenCalledWith({
        where: { id: 'seller-wallet' },
        data: { balance: { increment: new Prisma.Decimal(200) } },
      });
    });
  });

  describe('getOrder', () => {
    it('throws 404 when the order does not exist', async () => {
      prisma.order.findUnique.mockResolvedValue(null);
      await expect(service.getOrder(orderId, buyerId)).rejects.toThrow(NotFoundException);
    });

    it('throws 403 for a user who is neither buyer nor seller', async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...baseOrder,
        buyer: { fullName: 'B', email: 'b@x.com' },
        seller: { fullName: 'S', email: 's@x.com' },
      } as any);
      await expect(service.getOrder(orderId, 'stranger')).rejects.toThrow(ForbiddenException);
    });

    it('returns the seller as the counterpart when the caller is the buyer', async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...baseOrder,
        buyer: { fullName: 'Buyer', email: 'buyer@x.com' },
        seller: { fullName: 'Seller', email: 'seller@x.com' },
      } as any);

      const result = await service.getOrder(orderId, buyerId);

      expect(result.counterpart).toEqual({ role: 'SELLER', fullName: 'Seller', email: 'seller@x.com' });
    });

    it('returns the buyer as the counterpart when the caller is the seller', async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...baseOrder,
        buyer: { fullName: 'Buyer', email: 'buyer@x.com' },
        seller: { fullName: 'Seller', email: 'seller@x.com' },
      } as any);

      const result = await service.getOrder(orderId, sellerId);

      expect(result.counterpart).toEqual({ role: 'BUYER', fullName: 'Buyer', email: 'buyer@x.com' });
    });
  });
});
