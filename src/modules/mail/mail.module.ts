import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';

// عام حتى تستطيع كل الموديولات القادمة إرسال الإيميلات دون إعادة استيراد
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
