import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvVariables } from 'src/types/declartion-mergin';
import * as qrcode from 'qrcode-terminal';

/**
 * إرسال رموز التحقق عبر واتساب باستخدام Baileys (غير رسمي، مجاني عبر QR).
 * مرن: لو الجلسة غير متصلة، يطبع الرمز في الـ console بدل ما يكسر الطلب.
 * ملاحظة: Baileys حزمة ESM، فنحمّلها ديناميكياً من سياق CommonJS.
 */
@Injectable()
export class WhatsappService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappService.name);
  private sock: any = null;
  private ready = false;
  private lastQr: string | null = null;
  private lastPairingCode: string | null = null;
  private pairingRequested = false;

  constructor(private readonly config: ConfigService<EnvVariables>) {}

  onModuleInit(): void {
    // مفتاح تعطيل: مفيد أثناء التطوير (nest --watch) لتفادي إعادة الربط
    // ووصول إشعار "Finished syncing" مع كل إعادة تشغيل. عند التعطيل يبقى
    // sendOtp يعمل ويطبع الرمز في الـ console. الافتراضي: مُفعّل.
    if (this.config.get<string>('WHATSAPP_ENABLED') === 'false') {
      this.logger.warn(
        'WhatsApp disabled (WHATSAPP_ENABLED=false); OTP codes will be logged to the console.',
      );
      return;
    }

    // نبدأ الاتصال دون حجب إقلاع التطبيق؛ أي فشل لا يكسر السيرفر
    void this.connect().catch((err) =>
      this.logger.error(
        `WhatsApp init failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }

  isReady(): boolean {
    return this.ready;
  }

  getQr(): string | null {
    return this.lastQr;
  }

  /** آخر كود اقتران مُولّد (للربط من لوحة/endpoint دون الوصول لسجلّات السيرفر). */
  getPairingCode(): string | null {
    return this.lastPairingCode;
  }

  /**
   * يعيد الربط من الصفر: يغلق الاتصال الحالي ويطلب كود اقتران جديد.
   * مفيد على البرودكشن إذا انتهت صلاحية الكود أو ضاعت الجلسة.
   */
  async relink(): Promise<{ message: string }> {
    if (this.config.get<string>('WHATSAPP_ENABLED') === 'false') {
      return { message: 'WhatsApp is disabled (WHATSAPP_ENABLED=false).' };
    }
    try {
      this.sock?.end?.(undefined);
    } catch {
      // نتجاهل أي خطأ عند إغلاق الاتصال القديم
    }
    this.sock = null;
    this.ready = false;
    this.lastQr = null;
    this.lastPairingCode = null;
    this.pairingRequested = false;
    await this.connect();
    return {
      message:
        'Reconnecting. Poll GET /seller/whatsapp/status for a fresh pairing code.',
    };
  }

  /** يرسل رمز التحقق عبر واتساب؛ عند عدم الاتصال يطبع بالـ console (fallback). */
  async sendOtp(phone: string, code: string): Promise<void> {
    const text =
      `*GalleryQ* verification code: *${code}*\n` +
      `Valid for a few minutes. Do not share this code with anyone.`;

    if (!this.sock || !this.ready) {
      this.logger.warn(
        `WhatsApp not connected; code for ${phone} (dev only): ${code}`,
      );
      return;
    }

    try {
      await this.sock.sendMessage(`${phone}@s.whatsapp.net`, { text });
    } catch (err) {
      this.logger.error(
        `Failed to send WhatsApp to ${phone}: ${
          err instanceof Error ? err.message : String(err)
        }. Code (dev only): ${code}`,
      );
    }
  }

  private async connect(): Promise<void> {
    const baileys: any = await import('@whiskeysockets/baileys');
    const makeWASocket = baileys.default ?? baileys.makeWASocket;
    const { useMultiFileAuthState, DisconnectReason, Browsers } = baileys;

    const authDir = this.config.get<string>('WHATSAPP_AUTH_DIR') ?? './wa-auth';
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    let version: unknown;
    try {
      ({ version } = await baileys.fetchLatestBaileysVersion());
    } catch {
      // نكمل بالنسخة الافتراضية لو تعذّر جلب أحدث نسخة
    }

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger: this.silentLogger(),
      browser: Browsers.ubuntu('Chrome'),
      // المشروع يرسل OTP فقط — لا نحتاج مزامنة سجل/حالة المحادثات.
      // إيقافها يمنع إشعار "Finished syncing" على هاتف البوت مع كل اتصال.
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      markOnlineOnConnect: false,
    });
    this.sock = sock;

    // الطريقة الأوثق للربط من التيرمينال: كود اقتران بدل مسح QR.
    // يتطلّب WHATSAPP_PAIRING_NUMBER (رقم واتساب البوت بصيغة دولية بدون +).
    const pairingNumber = this.pairingNumber();
    if (
      pairingNumber &&
      !sock.authState.creds.registered &&
      !this.pairingRequested
    ) {
      this.pairingRequested = true;
      setTimeout(() => {
        void (async () => {
          try {
            const code: string = await sock.requestPairingCode(pairingNumber);
            this.lastPairingCode = code;
            this.logger.warn(
              `WhatsApp pairing code: ${code}  —  open WhatsApp → Linked Devices → Link a Device → "Link with phone number instead", then enter this code.`,
            );
          } catch (err) {
            this.logger.error(
              `Failed to get pairing code: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        })();
      }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.lastQr = qr;
        // لا نطبع QR إذا كنّا نستخدم كود الاقتران (نتجنّب إرباك التيرمينال)
        if (!pairingNumber) {
          this.logger.warn('WhatsApp: scan this QR to link the account:');
          qrcode.generate(qr, { small: true });
        }
      }

      if (connection === 'open') {
        this.ready = true;
        this.lastQr = null;
        this.lastPairingCode = null;
        this.logger.log('WhatsApp connected and ready.');
      }

      if (connection === 'close') {
        // نتجاهل إغلاق أي socket قديم استُبدل بآخر (مثلاً بعد relink)
        if (this.sock !== sock) {
          return;
        }
        this.ready = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        if (loggedOut) {
          this.pairingRequested = false;
          this.logger.error(
            'WhatsApp logged out. Delete the auth dir and link again.',
          );
        } else {
          this.logger.warn('WhatsApp connection closed. Reconnecting in 3s...');
          setTimeout(() => void this.connect().catch(() => undefined), 3000);
        }
      }
    });
  }

  private pairingNumber(): string | null {
    const raw = this.config.get<string>('WHATSAPP_PAIRING_NUMBER');
    if (!raw) return null;
    const digits = raw.replace(/\D/g, '');
    return digits || null;
  }

  /** Baileys يتطلّب logger بواجهة pino؛ نمرّر واحداً صامتاً. */
  private silentLogger(): any {
    const noop = (): void => undefined;
    const logger: any = { level: 'silent', child: () => logger };
    for (const method of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
      logger[method] = noop;
    }
    return logger;
  }
}
