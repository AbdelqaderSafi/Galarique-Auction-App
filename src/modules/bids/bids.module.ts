import { Module } from '@nestjs/common';
import { BidsController } from './bids.controller';
import { BidsService } from './bids.service';
import { WalletModule } from '../wallet/wallet.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { SchedulerModule } from '../scheduler/scheduler.module';

@Module({
  imports: [WalletModule, RealtimeModule, SchedulerModule],
  controllers: [BidsController],
  providers: [BidsService],
})
export class BidsModule {}
