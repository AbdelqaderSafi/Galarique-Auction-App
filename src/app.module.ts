import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './modules/database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { MailModule } from './modules/mail/mail.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { FirebaseAdminModule } from './modules/firebase/firebase-admin.module';
import { SellerVerificationModule } from './modules/seller-verification/seller-verification.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    MailModule,
    FirebaseAdminModule,
    AuthModule,
    CategoriesModule,
    UploadsModule,
    SellerVerificationModule,
  ],
})
export class AppModule {}
