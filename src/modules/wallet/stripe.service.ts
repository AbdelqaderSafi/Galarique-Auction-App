import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { EnvVariables } from 'src/types/declartion-mergin';

// غلاف رفيع فوق Stripe SDK — client كسول يُنشأ مرة واحدة (مثل UploadsService)
@Injectable()
export class StripeService {
  private client: Stripe | null = null;

  constructor(private readonly config: ConfigService<EnvVariables>) {}

  // جلسة Checkout لشحن المحفظة — المبلغ بالسنت، ونمرّر userId في الـ metadata
  async createCheckoutSession(
    userId: string,
    amountCents: number,
  ): Promise<Stripe.Checkout.Session> {
    const stripe = this.getClient();
    const frontend = this.frontendUrl();

    return stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: amountCents,
            product_data: { name: 'GalleryQ wallet top-up' },
          },
        },
      ],
      metadata: { userId },
      success_url: `${frontend}/wallet/topup/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontend}/wallet/topup/cancel`,
    });
  }

  // التحقق من توقيع الـ webhook باستخدام STRIPE_WEBHOOK_SECRET
  constructEvent(payload: Buffer, signature: string): Stripe.Event {
    const stripe = this.getClient();
    const secret = this.config.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!secret) {
      throw new ServiceUnavailableException(
        'Stripe is not configured. Set STRIPE_WEBHOOK_SECRET.',
      );
    }
    try {
      return stripe.webhooks.constructEvent(payload, signature, secret);
    } catch (error) {
      throw new BadRequestException(
        `Webhook signature verification failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // إنشاء حساب Connect Express للبائع
  async createConnectAccount(email?: string): Promise<Stripe.Account> {
    const stripe = this.getClient();
    return stripe.accounts.create({ type: 'express', email });
  }

  // رابط onboarding (توثيق الحساب) — يعيد المستخدم للفرونت
  async createAccountLink(accountId: string): Promise<Stripe.AccountLink> {
    const stripe = this.getClient();
    const frontend = this.frontendUrl();
    return stripe.accountLinks.create({
      account: accountId,
      type: 'account_onboarding',
      return_url: `${frontend}/wallet/connect/return`,
      refresh_url: `${frontend}/wallet/connect/refresh`,
    });
  }

  async retrieveAccount(accountId: string): Promise<Stripe.Account> {
    const stripe = this.getClient();
    return stripe.accounts.retrieve(accountId);
  }

  // تحويل الرصيد إلى الحساب المرتبط (السحب الفوري)
  async createTransfer(
    amountCents: number,
    destination: string,
  ): Promise<Stripe.Transfer> {
    const stripe = this.getClient();
    return stripe.transfers.create({
      amount: amountCents,
      currency: 'usd',
      destination,
    });
  }

  // يُنشأ مرّة واحدة؛ يرمي خطأً واضحاً إن كان مفتاح Stripe ناقصاً
  private getClient(): Stripe {
    if (this.client) {
      return this.client;
    }
    const secretKey = this.config.get<string>('STRIPE_SECRET_KEY');
    if (!secretKey) {
      throw new ServiceUnavailableException(
        'Stripe is not configured. Set STRIPE_SECRET_KEY.',
      );
    }
    this.client = new Stripe(secretKey);
    return this.client;
  }

  private frontendUrl(): string {
    return this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:3000';
  }
}
