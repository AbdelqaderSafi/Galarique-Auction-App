import type { User } from 'generated/prisma/client';

export interface EnvVariables {
  JWT_SECRET: string;
  DATABASE_URL: string;
  GOOGLE_CLIENT_ID: string;

  // إعادة تعيين كلمة المرور + البريد (Brevo HTTP API)
  FRONTEND_URL: string;
  BREVO_API_KEY: string;
  MAIL_FROM: string;

  // إعدادات رموز التحقق (OTP) للإيميل/الهاتف
  OTP_EXP_MINUTES: string;
  OTP_MAX_ATTEMPTS: string;

  // رفع الصور (ImageKit)
  IMAGEKIT_PUBLIC_KEY: string;
  IMAGEKIT_PRIVATE_KEY: string;
  IMAGEKIT_URL_ENDPOINT: string;

  // المدفوعات (Stripe) — شحن المحفظة (Checkout + webhook) والسحب (Connect)
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;

  // واتساب (Baileys) — مجلد جلسة الاتصال (اختياري، الافتراضي ./wa-auth)
  WHATSAPP_AUTH_DIR?: string;
  // رقم واتساب البوت (دولي بدون +) — لتفعيل الربط بكود اقتران بدل QR
  WHATSAPP_PAIRING_NUMBER?: string;
  // تعطيل اتصال واتساب أثناء التطوير ("false")؛ الافتراضي مُفعّل
  WHATSAPP_ENABLED?: string;
}

// الحقول الحسّاسة التي يجب ألّا تُعاد أبداً في أي response
export type SafeUser = Omit<User, 'password'>;

declare module 'express' {
  interface Request {
    user?: SafeUser;
  }
}
