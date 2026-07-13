import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import Stripe from 'stripe';
import {
  Prisma,
  WalletTxnType,
  WithdrawalStatus,
  type Wallet,
  type WalletTransaction,
} from 'generated/prisma/client';
import { DatabaseService } from '../database/database.service';
import { StripeService } from './stripe.service';
import type {
  CheckoutResponse,
  ConnectLinkResponse,
  ConnectStatusResponse,
  TopUpStatusResponse,
  TransactionsResponse,
  WalletResponse,
  WalletTransactionResponse,
  WebhookResponse,
  WithdrawResponse,
} from './dto/wallet.dto';

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    private readonly prisma: DatabaseService,
    private readonly stripe: StripeService,
  ) {}

  // ===== Balance & ledger =====

  async getWallet(userId: string): Promise<WalletResponse> {
    const wallet = await this.getOrCreateWallet(userId);
    return {
      balance: wallet.balance.toFixed(2),
      lockedBalance: wallet.lockedBalance.toFixed(2),
      currency: 'USD',
    };
  }

  async getTransactions(
    userId: string,
    page = 1,
    limit = 20,
  ): Promise<TransactionsResponse> {
    const safePage = page > 0 ? page : 1;
    const safeLimit = limit > 0 && limit <= 100 ? limit : 20;
    const skip = (safePage - 1) * safeLimit;

    const where = { wallet: { userId } };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.walletTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
      }),
      this.prisma.walletTransaction.count({ where }),
    ]);

    return {
      items: rows.map((row) => this.formatTxn(row)),
      page: safePage,
      limit: safeLimit,
      total,
    };
  }

  // ===== Top-up (Stripe Checkout) =====

  async createTopUp(userId: string, amount: number): Promise<CheckoutResponse> {
    await this.getOrCreateWallet(userId);
    const cents = Math.round(amount * 100);
    const session = await this.stripe.createCheckoutSession(userId, cents);
    if (!session.url) {
      throw new InternalServerErrorException(
        'Stripe did not return a checkout URL.',
      );
    }
    return { checkoutUrl: session.url };
  }

  // للعميل بعد الرجوع من صفحة الدفع: هل الجلسة مدفوعة؟ وهل اتشحنت بالمحفظة؟
  // (المصدر الرسمي للشحن هو الـ webhook؛ هذا للتأكيد من جهة الموبايل فقط)
  async getTopUpStatus(
    userId: string,
    sessionId: string,
  ): Promise<TopUpStatusResponse> {
    let session: Stripe.Checkout.Session;
    try {
      session = await this.stripe.retrieveCheckoutSession(sessionId);
    } catch {
      throw new NotFoundException('Checkout session not found.');
    }

    // الجلسة لازم تخص نفس المستخدم — لا نكشف حالة جلسات الآخرين
    if (session.metadata?.userId !== userId) {
      throw new NotFoundException('Checkout session not found.');
    }

    const paid = session.payment_status === 'paid';

    // اتشحنت فعلاً؟ = عندنا حركة TOPUP مرجعها هذه الجلسة (الـ webhook عالجها)
    const txn = await this.prisma.walletTransaction.findFirst({
      where: { refId: session.id, type: WalletTxnType.TOPUP },
    });

    const amount =
      txn?.amount.toFixed(2) ??
      (session.amount_total != null
        ? new Prisma.Decimal(session.amount_total).div(100).toFixed(2)
        : null);

    return { paid, credited: !!txn, amount };
  }

  // يتحقّق من التوقيع ثم يعالج الحدث — التأكيد يعتمد على الـ webhook لا على العميل
  async handleWebhook(
    payload: Buffer,
    signature: string,
  ): Promise<WebhookResponse> {
    const event = this.stripe.constructEvent(payload, signature);

    if (event.type === 'checkout.session.completed') {
      await this.creditTopUp(event.id, event.data.object);
    }

    return { received: true };
  }

  // شحن المحفظة بشكل ذرّي وآمن ضد التكرار (idempotent عبر stripeEventId الفريد)
  private async creditTopUp(
    eventId: string,
    session: Stripe.Checkout.Session,
  ): Promise<void> {
    if (session.payment_status !== 'paid') {
      return; // لم يُدفع بعد
    }
    const userId = session.metadata?.userId;
    const amountTotal = session.amount_total; // بالسنت
    if (!userId || amountTotal == null) {
      this.logger.warn(
        `checkout.session.completed missing userId/amount_total (session ${session.id})`,
      );
      return;
    }

    const amountDec = new Prisma.Decimal(amountTotal).div(100); // بالدولار

    try {
      await this.prisma.$transaction(async (tx) => {
        const wallet = await tx.wallet.upsert({
          where: { userId },
          create: { userId },
          update: {},
        });
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            type: WalletTxnType.TOPUP,
            amount: amountDec,
            refId: session.id,
            stripeEventId: eventId,
            note: 'Wallet top-up via Stripe Checkout',
          },
        });
        await tx.wallet.update({
          where: { id: wallet.id },
          data: { balance: { increment: amountDec } },
        });
      });
    } catch (error) {
      // حدث مكرّر (نفس eventId) → معالَج سابقاً، نتجاهله بدون شحن مزدوج
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        this.logger.log(`Duplicate Stripe event ${eventId} ignored`);
        return;
      }
      throw error;
    }
  }

  // ===== Withdrawal (Stripe Connect — synchronous Transfer) =====

  async connectOnboard(userId: string): Promise<ConnectLinkResponse> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });

    let connectId = user.stripeConnectId;
    if (!connectId) {
      const account = await this.stripe.createConnectAccount(user.email);
      connectId = account.id;
      await this.prisma.user.update({
        where: { id: userId },
        data: { stripeConnectId: connectId },
      });
    }

    const link = await this.stripe.createAccountLink(connectId);
    return { url: link.url };
  }

  async connectStatus(userId: string): Promise<ConnectStatusResponse> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (!user.stripeConnectId) {
      return {
        detailsSubmitted: false,
        chargesEnabled: false,
        payoutsEnabled: false,
      };
    }
    const account = await this.stripe.retrieveAccount(user.stripeConnectId);
    return {
      detailsSubmitted: !!account.details_submitted,
      chargesEnabled: !!account.charges_enabled,
      payoutsEnabled: !!account.payouts_enabled,
    };
  }

  async requestWithdrawal(
    userId: string,
    amount: number,
  ): Promise<WithdrawResponse> {
    const amountDec = new Prisma.Decimal(amount.toFixed(2));
    const cents = Math.round(amount * 100);

    // 1) لازم حساب Connect جاهز للتحويلات
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (!user.stripeConnectId) {
      throw new BadRequestException(
        'You need to set up a payout account first (POST /wallet/connect/onboard).',
      );
    }
    const account = await this.stripe.retrieveAccount(user.stripeConnectId);
    if (!account.payouts_enabled) {
      throw new BadRequestException(
        'Your Stripe account is not ready for payouts yet. Complete onboarding.',
      );
    }

    // 2) خصم ذرّي محمي — يمنع سباق السحب المزدوج
    await this.getOrCreateWallet(userId);
    const debit = await this.prisma.wallet.updateMany({
      where: { userId, balance: { gte: amountDec } },
      data: { balance: { decrement: amountDec } },
    });
    if (debit.count === 0) {
      throw new BadRequestException('Insufficient balance.');
    }

    // 3) سجل السحب PENDING
    const withdrawal = await this.prisma.withdrawal.create({
      data: { userId, amount: amountDec, status: WithdrawalStatus.PENDING },
    });

    // 4) التحويل الفعلي عبر Stripe
    try {
      const transfer = await this.stripe.createTransfer(
        cents,
        user.stripeConnectId,
      );
      await this.prisma.$transaction(async (tx) => {
        await tx.withdrawal.update({
          where: { id: withdrawal.id },
          data: {
            status: WithdrawalStatus.PAID,
            stripePayoutId: transfer.id,
          },
        });
        const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId } });
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            type: WalletTxnType.WITHDRAW,
            amount: amountDec,
            refId: withdrawal.id,
            note: 'Withdrawal via Stripe Connect',
          },
        });
      });
      return { withdrawalId: withdrawal.id, status: WithdrawalStatus.PAID };
    } catch (error) {
      // فشل التحويل → نُرجِع الرصيد ونضع الحالة FAILED
      await this.prisma.$transaction(async (tx) => {
        await tx.wallet.update({
          where: { userId },
          data: { balance: { increment: amountDec } },
        });
        await tx.withdrawal.update({
          where: { id: withdrawal.id },
          data: { status: WithdrawalStatus.FAILED },
        });
      });
      throw new BadRequestException(
        `Withdrawal failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // ===== Helpers =====

  // ينشئ المحفظة إن لم تكن موجودة (كل مستخدم له محفظة واحدة)
  private getOrCreateWallet(userId: string): Promise<Wallet> {
    return this.prisma.wallet.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
  }

  private formatTxn(row: WalletTransaction): WalletTransactionResponse {
    return {
      id: row.id,
      type: row.type,
      amount: row.amount.toFixed(2),
      refId: row.refId,
      note: row.note,
      createdAt: row.createdAt,
    };
  }
}
