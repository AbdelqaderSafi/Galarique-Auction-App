import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { SettlementService } from './settlement.service';

@Module({
  controllers: [OrdersController],
  providers: [OrdersService, SettlementService],
  exports: [SettlementService], // يستخدمه موديول scheduler
})
export class OrdersModule {}
