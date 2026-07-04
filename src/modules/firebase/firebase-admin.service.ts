import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { App, cert, getApp, getApps, initializeApp } from 'firebase-admin/app';
import { DecodedIdToken, getAuth } from 'firebase-admin/auth';
import { EnvVariables } from 'src/types/declartion-mergin';

@Injectable()
export class FirebaseAdminService {
  private app: App | null = null;

  constructor(private readonly configService: ConfigService<EnvVariables>) {}

  async verifyIdToken(idToken: string): Promise<DecodedIdToken> {
    const app = this.getApp();
    try {
      return await getAuth(app).verifyIdToken(idToken);
    } catch {
      throw new UnauthorizedException('Invalid or expired Firebase token');
    }
  }

  // يُهيّأ مرّة واحدة (lazy) حتى لا يسقط الإقلاع إن كانت المفاتيح ناقصة
  private getApp(): App {
    if (this.app) {
      return this.app;
    }

    const projectId = this.configService.get<string>('FIREBASE_PROJECT_ID');
    const clientEmail = this.configService.get<string>('FIREBASE_CLIENT_EMAIL');
    const rawPrivateKey = this.configService.get<string>(
      'FIREBASE_PRIVATE_KEY',
    );

    if (!projectId || !clientEmail || !rawPrivateKey) {
      throw new ServiceUnavailableException(
        'Firebase is not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY.',
      );
    }

    // تحويل \n المهرّبة إلى أسطر فعلية (مهم عند تخزين المفتاح في متغيّر بيئة)
    const privateKey = rawPrivateKey.replace(/\\n/g, '\n');

    // نعيد استخدام التطبيق الافتراضي إن كان مُهيّأً مسبقاً
    this.app = getApps().length
      ? getApp()
      : initializeApp({
          credential: cert({ projectId, clientEmail, privateKey }),
        });

    return this.app;
  }
}
