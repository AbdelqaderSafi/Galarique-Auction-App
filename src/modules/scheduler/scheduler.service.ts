import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SettlementService } from '../orders/settlement.service';
import type { SchedulerRunResponse } from '../orders/dto/orders.dto';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(private readonly settlement: SettlementService) {}

  // الإغلاق على دورة سريعة: endTime لحظة عشوائية (= ثانية موافقة الأدمن)، ودورة
  // الدقيقة كانت تترك المزاد مفتوحاً حتى 59 ثانية بعد انتهائه. الاستعلام مفهرس
  // (@@index([status, endTime])) والإغلاق idempotent تحت قفل الصف، فالتكرار آمن.
  @Cron(CronExpression.EVERY_5_SECONDS)
  async closeTick(): Promise<void> {
    await this.settlement.closeDueAuctions();
  }

  // التسوية المالية كل دقيقة — مهلة الدفع 72 ساعة، فالدقيقة أكثر من كافية.
  // كل مهمة "تمسح المستحقّ"، فالدورة الفائتة تُلتقط بالدورة الجاية.
  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    const expired = await this.settlement.expirePaymentDeadlines();
    const retriedPaid = await this.settlement.retryWinnerPayments();

    if (expired || retriedPaid) {
      this.logger.log(`tick: expired=${expired} retriedPaid=${retriedPaid}`);
    }
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
    return { closed, expired, retriedPaid };
  }
}
