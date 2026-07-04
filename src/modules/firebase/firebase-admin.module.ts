import { Global, Module } from '@nestjs/common';
import { FirebaseAdminService } from './firebase-admin.service';

// عام حتى تستطيع أي موديول استخدام FirebaseAdminService
@Global()
@Module({
  providers: [FirebaseAdminService],
  exports: [FirebaseAdminService],
})
export class FirebaseAdminModule {}
