import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { OrdersModule } from '../orders/orders.module';
import { SchedulerController } from './scheduler.controller';
import { SchedulerService } from './scheduler.service';

@Module({
  imports: [ScheduleModule.forRoot(), OrdersModule],
  controllers: [SchedulerController],
  providers: [SchedulerService],
})
export class SchedulerModule {}
