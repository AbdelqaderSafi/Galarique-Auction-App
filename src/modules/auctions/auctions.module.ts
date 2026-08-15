import { Module } from '@nestjs/common';
import { AuctionsController } from './auctions.controller';
import { AuctionsService } from './auctions.service';
import { UploadsModule } from '../uploads/uploads.module';
import { OrdersModule } from '../orders/orders.module';
import { WalletModule } from '../wallet/wallet.module';
import { SchedulerModule } from '../scheduler/scheduler.module';

@Module({
  imports: [UploadsModule, OrdersModule, WalletModule, SchedulerModule],
  controllers: [AuctionsController],
  providers: [AuctionsService],
  exports: [AuctionsService],
})
export class AuctionsModule {}
