import { BadRequestException } from '@nestjs/common';
import { DepositStatus, Prisma, WalletTxnType, WithdrawalStatus } from 'generated/prisma/client';
import { WalletService } from './wallet.service';
import { StripeService } from './stripe.service';
import {
  createMockDatabaseService,
  resetMockDatabaseService,
  type MockDatabaseService,
} from '../../test-utils/prisma-mock';

describe('WalletService', () => {
  let prisma: MockDatabaseService;
  let stripe: jest.Mocked<StripeService>;
  let service: WalletService;

  beforeEach(() => {
    prisma = createMockDatabaseService();
    stripe = {
      createCheckoutSession: jest.fn(),
      retrieveCheckoutSession: jest.fn(),
      constructEvent: jest.fn(),
      createConnectAccount: jest.fn(),
      createAccountLink: jest.fn(),
      retrieveAccount: jest.fn(),
      createTransfer: jest.fn(),
    } as unknown as jest.Mocked<StripeService>;
    service = new WalletService(prisma, stripe);
  });

  afterEach(() => {
    resetMockDatabaseService(prisma);
    jest.clearAllMocks();
  });

  describe('holdBidDeposit', () => {
    const userId = 'user-1';
    const auctionId = 'auction-1';

    it('holds $50, moves balance -> lockedBalance, and returns true on first hold', async () => {
      prisma.wallet.upsert.mockResolvedValue({ id: 'wallet-1', userId, balance: new Prisma.Decimal(100), lockedBalance: new Prisma.Decimal(0) } as any);
      prisma.auctionDeposit.findUnique.mockResolvedValue(null);
      prisma.wallet.updateMany.mockResolvedValue({ count: 1 } as any);
      prisma.auctionDeposit.upsert.mockResolvedValue({} as any);

      const held = await service.holdBidDeposit(prisma, userId, auctionId);

      expect(held).toBe(true);
      expect(prisma.wallet.updateMany).toHaveBeenCalledWith({
        where: { id: 'wallet-1', balance: { gte: new Prisma.Decimal(50) } },
        data: {
          balance: { decrement: new Prisma.Decimal(50) },
          lockedBalance: { increment: new Prisma.Decimal(50) },
        },
      });
      expect(prisma.auctionDeposit.upsert).toHaveBeenCalledWith({
        where: { auctionId_userId: { auctionId, userId } },
        create: { auctionId, userId, status: 'HELD', amount: new Prisma.Decimal(50) },
        update: { status: 'HELD' },
      });
      expect(prisma.walletTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: WalletTxnType.DEPOSIT_HOLD, amount: new Prisma.Decimal(50) }),
        }),
      );
    });

    it('is idempotent: returns false without touching balance if already HELD for this auction', async () => {
      prisma.wallet.upsert.mockResolvedValue({ id: 'wallet-1', userId } as any);
      prisma.auctionDeposit.findUnique.mockResolvedValue({ status: 'HELD' } as any);

      const held = await service.holdBidDeposit(prisma, userId, auctionId);

      expect(held).toBe(false);
      expect(prisma.wallet.updateMany).not.toHaveBeenCalled();
      expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    });

    it('re-holds (RELEASED -> HELD) for a user retaking the lead on the same auction', async () => {
      prisma.wallet.upsert.mockResolvedValue({ id: 'wallet-1', userId } as any);
      prisma.auctionDeposit.findUnique.mockResolvedValue({ status: 'RELEASED' } as any);
      prisma.wallet.updateMany.mockResolvedValue({ count: 1 } as any);

      const held = await service.holdBidDeposit(prisma, userId, auctionId);

      expect(held).toBe(true);
      expect(prisma.wallet.updateMany).toHaveBeenCalled();
    });

    it('throws 400 with needed/available amounts when balance < $50', async () => {
      prisma.wallet.upsert.mockResolvedValue({ id: 'wallet-1', userId } as any);
      prisma.auctionDeposit.findUnique.mockResolvedValue(null);
      prisma.wallet.updateMany.mockResolvedValue({ count: 0 } as any);
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({ balance: new Prisma.Decimal(20) } as any);

      await expect(service.holdBidDeposit(prisma, userId, auctionId)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.holdBidDeposit(prisma, userId, auctionId)).rejects.toThrow(
        /Needed: \$50\.00, available: \$20\.00/,
      );
      expect(prisma.auctionDeposit.upsert).not.toHaveBeenCalled();
    });
  });

  describe('releaseBidDeposit', () => {
    const userId = 'user-1';
    const auctionId = 'auction-1';

    it('moves lockedBalance -> balance and marks the deposit RELEASED when HELD', async () => {
      prisma.auctionDeposit.findUnique.mockResolvedValue({ status: 'HELD' } as any);
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({ id: 'wallet-1', userId } as any);

      await service.releaseBidDeposit(prisma, userId, auctionId);

      expect(prisma.wallet.update).toHaveBeenCalledWith({
        where: { id: 'wallet-1' },
        data: {
          lockedBalance: { decrement: new Prisma.Decimal(50) },
          balance: { increment: new Prisma.Decimal(50) },
        },
      });
      expect(prisma.auctionDeposit.update).toHaveBeenCalledWith({
        where: { auctionId_userId: { auctionId, userId } },
        data: { status: 'RELEASED' },
      });
      expect(prisma.walletTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: WalletTxnType.DEPOSIT_RELEASE }),
        }),
      );
    });

    it('is a no-op when there is no deposit row for this (auction, user)', async () => {
      prisma.auctionDeposit.findUnique.mockResolvedValue(null);

      await service.releaseBidDeposit(prisma, userId, auctionId);

      expect(prisma.wallet.update).not.toHaveBeenCalled();
      expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    });

    it('is a no-op when the deposit is already RELEASED (never double-releases)', async () => {
      prisma.auctionDeposit.findUnique.mockResolvedValue({ status: 'RELEASED' } as any);

      await service.releaseBidDeposit(prisma, userId, auctionId);

      expect(prisma.wallet.update).not.toHaveBeenCalled();
    });
  });

  describe('requestWithdrawal', () => {
    const userId = 'user-1';

    it('rejects when the user has no Connect account yet', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({ id: userId, stripeConnectId: null } as any);

      await expect(service.requestWithdrawal(userId, 50)).rejects.toThrow(
        /set up a payout account/,
      );
    });

    it('rejects when payouts are not enabled on the Connect account', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({ id: userId, stripeConnectId: 'acct_1' } as any);
      stripe.retrieveAccount.mockResolvedValue({ payouts_enabled: false } as any);

      await expect(service.requestWithdrawal(userId, 50)).rejects.toThrow(
        /not ready for payouts/,
      );
    });

    it('rejects with insufficient balance and never creates a Withdrawal row', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({ id: userId, stripeConnectId: 'acct_1' } as any);
      stripe.retrieveAccount.mockResolvedValue({ payouts_enabled: true } as any);
      prisma.wallet.upsert.mockResolvedValue({ id: 'wallet-1' } as any);
      prisma.wallet.updateMany.mockResolvedValue({ count: 0 } as any);

      await expect(service.requestWithdrawal(userId, 500)).rejects.toThrow(
        'Insufficient balance.',
      );
      expect(prisma.withdrawal.create).not.toHaveBeenCalled();
    });

    it('debits, transfers via Stripe, and marks the withdrawal PAID on success', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        id: userId,
        stripeConnectId: 'acct_1',
        email: 'a@b.com',
      } as any);
      stripe.retrieveAccount.mockResolvedValue({ payouts_enabled: true } as any);
      prisma.wallet.upsert.mockResolvedValue({ id: 'wallet-1' } as any);
      prisma.wallet.updateMany.mockResolvedValue({ count: 1 } as any);
      prisma.withdrawal.create.mockResolvedValue({ id: 'wd-1' } as any);
      stripe.createTransfer.mockResolvedValue({ id: 'tr_1' } as any);
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({ id: 'wallet-1', userId } as any);

      const result = await service.requestWithdrawal(userId, 50);

      expect(result).toEqual({ withdrawalId: 'wd-1', status: WithdrawalStatus.PAID });
      expect(prisma.withdrawal.update).toHaveBeenCalledWith({
        where: { id: 'wd-1' },
        data: { status: WithdrawalStatus.PAID, stripePayoutId: 'tr_1' },
      });
    });

    it('refunds the balance and marks the withdrawal FAILED when the Stripe transfer throws', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        id: userId,
        stripeConnectId: 'acct_1',
        email: 'a@b.com',
      } as any);
      stripe.retrieveAccount.mockResolvedValue({ payouts_enabled: true } as any);
      prisma.wallet.upsert.mockResolvedValue({ id: 'wallet-1' } as any);
      prisma.wallet.updateMany.mockResolvedValue({ count: 1 } as any);
      prisma.withdrawal.create.mockResolvedValue({ id: 'wd-1' } as any);
      stripe.createTransfer.mockRejectedValue(new Error('stripe down'));

      await expect(service.requestWithdrawal(userId, 50)).rejects.toThrow(
        /Withdrawal failed: stripe down/,
      );
      expect(prisma.wallet.update).toHaveBeenCalledWith({
        where: { userId },
        data: { balance: { increment: new Prisma.Decimal(50) } },
      });
      expect(prisma.withdrawal.update).toHaveBeenCalledWith({
        where: { id: 'wd-1' },
        data: { status: WithdrawalStatus.FAILED },
      });
    });
  });

  describe('creditTopUp (via handleWebhook)', () => {
    it('credits the wallet balance on a paid checkout.session.completed event', async () => {
      const session = {
        id: 'cs_1',
        payment_status: 'paid',
        amount_total: 5000, // $50.00
        metadata: { userId: 'user-1' },
      };
      stripe.constructEvent.mockReturnValue({
        id: 'evt_1',
        type: 'checkout.session.completed',
        data: { object: session },
      } as any);
      prisma.wallet.upsert.mockResolvedValue({ id: 'wallet-1' } as any);

      await service.handleWebhook(Buffer.from('{}'), 'sig');

      expect(prisma.walletTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          walletId: 'wallet-1',
          type: WalletTxnType.TOPUP,
          amount: new Prisma.Decimal(50),
          refId: 'cs_1',
          stripeEventId: 'evt_1',
        }),
      });
      expect(prisma.wallet.update).toHaveBeenCalledWith({
        where: { id: 'wallet-1' },
        data: { balance: { increment: new Prisma.Decimal(50) } },
      });
    });

    it('ignores unpaid sessions without crediting anything', async () => {
      stripe.constructEvent.mockReturnValue({
        id: 'evt_2',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_2', payment_status: 'unpaid', metadata: { userId: 'user-1' } } },
      } as any);

      await service.handleWebhook(Buffer.from('{}'), 'sig');

      expect(prisma.wallet.upsert).not.toHaveBeenCalled();
      expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    });

    it('swallows a duplicate Stripe event (P2002) instead of double-crediting', async () => {
      const session = {
        id: 'cs_3',
        payment_status: 'paid',
        amount_total: 1000,
        metadata: { userId: 'user-1' },
      };
      stripe.constructEvent.mockReturnValue({
        id: 'evt_3',
        type: 'checkout.session.completed',
        data: { object: session },
      } as any);
      prisma.wallet.upsert.mockResolvedValue({ id: 'wallet-1' } as any);
      prisma.$transaction.mockImplementationOnce(() =>
        Promise.reject(
          new Prisma.PrismaClientKnownRequestError('duplicate', {
            code: 'P2002',
            clientVersion: '7.0.0',
          }),
        ),
      );

      await expect(
        service.handleWebhook(Buffer.from('{}'), 'sig'),
      ).resolves.toEqual({ received: true });
    });
  });
});
