import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { SettlementService } from './settlement.service';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [RealtimeModule],
  controllers: [OrdersController],
  providers: [OrdersService, SettlementService],
  exports: [SettlementService], // يستخدمه موديول scheduler
})
export class OrdersModule {}
