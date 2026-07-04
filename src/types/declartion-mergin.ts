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

  // توثيق الهاتف (Firebase Admin)
  FIREBASE_PROJECT_ID: string;
  FIREBASE_CLIENT_EMAIL: string;
  FIREBASE_PRIVATE_KEY: string;
}

// الحقول الحسّاسة التي يجب ألّا تُعاد أبداً في أي response
export type SafeUser = Omit<
  User,
  'password' | 'resetToken' | 'resetTokenExpiry'
>;

declare module 'express' {
  interface Request {
    user?: SafeUser;
  }
}
