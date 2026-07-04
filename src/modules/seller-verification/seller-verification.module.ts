import { Module } from '@nestjs/common';
import { SellerVerificationService } from './seller-verification.service';
import { SellerVerificationController } from './seller-verification.controller';
import { UserModule } from '../user/user.module';

@Module({
  imports: [UserModule],
  controllers: [SellerVerificationController],
  providers: [SellerVerificationService],
})
export class SellerVerificationModule {}
