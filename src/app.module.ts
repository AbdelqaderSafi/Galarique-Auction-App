import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './modules/database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { MailModule } from './modules/mail/mail.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { WhatsappModule } from './modules/whatsapp/whatsapp.module';
import { SellerVerificationModule } from './modules/seller-verification/seller-verification.module';
import { AuctionsModule } from './modules/auctions/auctions.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { BidsModule } from './modules/bids/bids.module';
import { OrdersModule } from './modules/orders/orders.module';
import { SchedulerModule } from './modules/scheduler/scheduler.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    MailModule,
    WhatsappModule,
    AuthModule,
    CategoriesModule,
    UploadsModule,
    SellerVerificationModule,
    AuctionsModule,
    WalletModule,
    BidsModule,
    OrdersModule,
    SchedulerModule,
  ],
})
export class AppModule {}
