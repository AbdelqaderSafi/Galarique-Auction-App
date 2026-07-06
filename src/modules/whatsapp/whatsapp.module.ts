import { Global, Module } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';

// عام حتى تستطيع الموديولات إرسال رسائل واتساب دون إعادة استيراد
@Global()
@Module({
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
