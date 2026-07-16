import { Controller, HttpCode, Post } from '@nestjs/common';
import { Role } from 'generated/prisma/client';
import { Roles } from 'src/decorators/roles.decorator';
import { SchedulerService } from './scheduler.service';
import type { SchedulerRunResponse } from '../orders/dto/orders.dto';
import {
  SwaggerSchedulerTag,
  ApiRunScheduler,
} from 'src/swagger/scheduler.swagger';

@SwaggerSchedulerTag()
@Controller('scheduler')
export class SchedulerController {
  constructor(private readonly scheduler: SchedulerService) {}

  // ذراع يدوي: للاختبار بدون انتظار الدقيقة، وللإنقاذ لو توقّف الـ cron
  @Post('run')
  @HttpCode(200)
  @Roles([Role.ADMIN])
  @ApiRunScheduler()
  run(): Promise<SchedulerRunResponse> {
    return this.scheduler.runAll();
  }
}
