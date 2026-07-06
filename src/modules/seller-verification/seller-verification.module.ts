import { Module } from '@nestjs/common';
import { SellerVerificationController } from './seller-verification.controller';
import { SellerVerificationService } from './seller-verification.service';
import { PhoneVerificationService } from './phone-verification.service';

@Module({
  controllers: [SellerVerificationController],
  providers: [SellerVerificationService, PhoneVerificationService],
})
export class SellerVerificationModule {}
