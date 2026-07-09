import { Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { StripeService } from './stripe.service';

@Module({
  controllers: [WalletController],
  providers: [WalletService, StripeService],
  exports: [WalletService], // bids سيستخدمه لاحقاً لحجز/إرجاع عربون $50
})
export class WalletModule {}
