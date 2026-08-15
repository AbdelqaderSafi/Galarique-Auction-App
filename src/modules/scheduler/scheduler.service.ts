import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AuctionStatus, OrderStatus } from 'generated/prisma/client';
import { DatabaseService } from '../database/database.service';
import { SettlementService } from '../orders/settlement.service';
import { DeadlineTimer } from './deadline-timer';
import type { SchedulerRunResponse } from '../orders/dto/orders.dto';

@Injectable()
export class SchedulerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(SchedulerService.name);

  private readonly closeTimer: DeadlineTimer;
  private readonly expiryTimer: DeadlineTimer;

  constructor(
    private readonly prisma: DatabaseService,
    private readonly settlement: SettlementService,
  ) {
    // مؤقّتان مدفوعان بالمواعيد بدل دورتَي cron. سبب التحوّل: أي cron أسرع من
    // 5 دقائق يمنع Neon من الدخول في scale-to-zero، فتُفوتر الحوسبة 24/7
    // (0.25 CU × 24h = 6 CU-hrs/يوم = كامل الحصّة المجانية خلال ~16 يوم).
    // المؤقّت ينام بالضبط حتى أقرب endTime/paymentDeadline، وإن لم يوجد أي
    // موعد قادم لا يُضبط مؤقّت أصلاً — صفر استعلامات، والقاعدة تنام.
    this.closeTimer = new DeadlineTimer(
      'auction-close',
      () => this.nextAuctionEnd(),
      () => this.closeDue(),
      this.logger,
    );
    this.expiryTimer = new DeadlineTimer(
      'payment-expiry',
      () => this.nextPaymentDeadline(),
      () => this.expireDue(),
      this.logger,
    );
  }

  onApplicationBootstrap(): void {
    // عند الإقلاع: أغلق ما فات أثناء توقّف الخدمة، ثم اضبط المؤقّتين
    this.reschedule();
  }

  onModuleDestroy(): void {
    this.closeTimer.stop();
    this.expiryTimer.stop();
  }

  /**
   * يستدعيها كل ما يغيّر موعداً مخزّناً: موافقة الأدمن على مزاد (تضبط endTime)،
   * تمديد anti-snipe، إلغاء مزاد، إنهاء يدوي. بدونها يبقى المؤقّت مضبوطاً على
   * موعد قديم وقد يتأخّر الإغلاق حتى دورة الأمان.
   */
  reschedule(): void {
    this.closeTimer.rearm();
    this.expiryTimer.rearm();
  }

  /** أقرب موعد مضبوط لكل مؤقّت — للتشخيص والاختبارات */
  get armedAt(): { close: Date | null; expiry: Date | null } {
    return {
      close: this.closeTimer.nextFireAt,
      expiry: this.expiryTimer.nextFireAt,
    };
  }

  /**
   * شبكة أمان لا أكثر: تلتقط أي موعد فات المؤقّت (انحراف ساعة، جهاز نائم،
   * استدعاء reschedule منسي)، وتحاول خصم مستحقّات الفائزين الذين شحنوا
   * محفظتهم بعد الإغلاق. كل 6 ساعات عمداً — 4 استيقاظات في اليوم بدل 1440،
   * والمشتري يملك على أي حال المسار اليدوي `POST /orders/:id/pay`.
   */
  @Cron(CronExpression.EVERY_6_HOURS)
  async sweep(): Promise<void> {
    await this.runAll();
  }

  // نفس المنطق الذي ينادَى يدوياً عبر POST /scheduler/run
  async runAll(): Promise<SchedulerRunResponse> {
    const closed = await this.settlement.closeDueAuctions();
    const expired = await this.settlement.expirePaymentDeadlines();
    const retriedPaid = await this.settlement.retryWinnerPayments();

    // لا نُغرق اللوج بدورات فاضية
    if (closed || expired || retriedPaid) {
      this.logger.log(
        `runAll: closed=${closed} expired=${expired} retriedPaid=${retriedPaid}`,
      );
    }
    this.reschedule();
    return { closed, expired, retriedPaid };
  }

  // ===== قراءة المواعيد — استعلام واحد مفهرس لكل مؤقّت =====

  // @@index([status, endTime])
  private async nextAuctionEnd(): Promise<Date | null> {
    const next = await this.prisma.auction.findFirst({
      where: { status: AuctionStatus.LIVE, endTime: { not: null } },
      orderBy: { endTime: 'asc' },
      select: { endTime: true },
    });
    return next?.endTime ?? null;
  }

  // @@index([status, paymentDeadline])
  private async nextPaymentDeadline(): Promise<Date | null> {
    const next = await this.prisma.order.findFirst({
      where: { status: OrderStatus.AWAITING_PAYMENT },
      orderBy: { paymentDeadline: 'asc' },
      select: { paymentDeadline: true },
    });
    return next?.paymentDeadline ?? null;
  }

  // ===== العمل عند حلول الموعد =====

  private async closeDue(): Promise<void> {
    const closed = await this.settlement.closeDueAuctions();
    if (!closed) return;

    this.logger.log(`closed=${closed}`);
    // كل إغلاق بفائز ينشئ Order بمهلة 72 ساعة — موعد جديد لمؤقّت المهلة
    this.expiryTimer.rearm();
  }

  private async expireDue(): Promise<void> {
    // انتهاء مهلة رتبة 1 قد يخلق عرض "فرصة ثانية" بمهلة جديدة — يلتقطها
    // إعادة الضبط التلقائية التي تلي كل تنفيذ داخل DeadlineTimer
    const expired = await this.settlement.expirePaymentDeadlines();
    if (expired) this.logger.log(`expired=${expired}`);
  }
}
