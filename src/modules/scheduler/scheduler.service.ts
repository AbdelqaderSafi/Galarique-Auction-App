import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SettlementService } from '../orders/settlement.service';
import type { SchedulerRunResponse } from '../orders/dto/orders.dto';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(private readonly settlement: SettlementService) {}

  // كل دقيقة — كل مهمة "تمسح المستحقّ"، فالدورة الفائتة تُلتقط بالدورة الجاية
  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
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
        `tick: closed=${closed} expired=${expired} retriedPaid=${retriedPaid}`,
      );
    }
    return { closed, expired, retriedPaid };
  }
}
