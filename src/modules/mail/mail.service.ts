import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvVariables } from 'src/types/declartion-mergin';

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
const DEFAULT_SENDER = {
  name: 'GalleryQ',
  email: 'no-reply@galleryq.com',
};

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly configService: ConfigService<EnvVariables>) {}

  async sendPasswordResetCode(
    to: string,
    fullName: string,
    code: string,
  ): Promise<void> {
    const subject = 'Your GalleryQ password reset code';
    const html = this.buildPasswordResetCodeHtml(fullName, code);
    const text =
      `Hi ${fullName},\n\n` +
      `Your GalleryQ password reset code is: ${code}\n` +
      `It is valid for a few minutes. Enter it in the app to set a new password.\n\n` +
      `If you didn't request this, you can safely ignore this email.`;

    await this.send({ to, subject, html, text, fallbackCode: code });
  }

  async sendEmailVerificationCode(
    to: string,
    fullName: string,
    code: string,
  ): Promise<void> {
    const subject = 'Your GalleryQ verification code';
    const html = this.buildVerificationCodeHtml(fullName, code);
    const text =
      `Hi ${fullName},\n\n` +
      `Your GalleryQ verification code is: ${code}\n` +
      `It is valid for a few minutes. Enter it to finish creating your account.\n\n` +
      `If you didn't sign up, you can safely ignore this email.`;

    await this.send({ to, subject, html, text, fallbackCode: code });
  }

  async sendAuctionApproved(
    to: string,
    fullName: string,
    auctionTitle: string,
  ): Promise<void> {
    const subject = `Your auction is live: ${auctionTitle}`;
    const html = this.buildAuctionApprovedHtml(fullName, auctionTitle);
    const text =
      `Hi ${fullName},\n\n` +
      `Good news — your auction "${auctionTitle}" has been approved and is now live on GalleryQ.\n` +
      `Buyers can start bidding right away.\n\n` +
      `Bid Smart. Win Big.`;

    await this.send({ to, subject, html, text });
  }

  async sendAuctionRejected(
    to: string,
    fullName: string,
    auctionTitle: string,
    reason: string,
  ): Promise<void> {
    const subject = `Your auction needs changes: ${auctionTitle}`;
    const html = this.buildAuctionRejectedHtml(fullName, auctionTitle, reason);
    const text =
      `Hi ${fullName},\n\n` +
      `Your auction "${auctionTitle}" was not approved.\n` +
      `Reason: ${reason}\n\n` +
      `You can edit it in the app and resubmit it for review.`;

    await this.send({ to, subject, html, text });
  }

  private async send(options: {
    to: string;
    subject: string;
    html: string;
    text: string;
    fallbackLink?: string;
    fallbackCode?: string;
  }): Promise<void> {
    const apiKey = this.configService.get<string>('BREVO_API_KEY');

    // مفتاح Brevo غير مضبوط: لا نُفشل الطلب، نطبع القيمة للتطوير المحلي
    if (!apiKey) {
      const hint = options.fallbackLink
        ? ` Link (dev only): ${options.fallbackLink}`
        : options.fallbackCode
          ? ` Code (dev only): ${options.fallbackCode}`
          : '';
      this.logger.warn(
        `BREVO_API_KEY is not set; skipping email to ${options.to}.${hint}`,
      );
      return;
    }

    const sender = this.resolveSender();

    try {
      const response = await fetch(BREVO_ENDPOINT, {
        method: 'POST',
        headers: {
          'api-key': apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          sender,
          to: [{ email: options.to }],
          subject: options.subject,
          htmlContent: options.html,
          textContent: options.text,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        this.logger.error(
          `Brevo API returned ${response.status} for ${options.to}: ${body}`,
        );
      }
    } catch (error) {
      // لا نُفشل الطلب بسبب البريد؛ نسجّل الخطأ فقط
      this.logger.error(
        `Failed to send email to ${options.to}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // يحلّل MAIL_FROM بصيغة "Name <email>" أو "email" مع قيمة افتراضية
  private resolveSender(): { name: string; email: string } {
    const raw = this.configService.get<string>('MAIL_FROM');
    if (!raw) {
      return DEFAULT_SENDER;
    }

    const match = raw.match(/^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/);
    if (match) {
      return {
        name: match[1] || DEFAULT_SENDER.name,
        email: match[2],
      };
    }

    return { name: DEFAULT_SENDER.name, email: raw.trim() };
  }

  private buildPasswordResetCodeHtml(fullName: string, code: string): string {
    return `
  <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
    <h2 style="margin: 0 0 16px;">Bid Smart. Win Big.</h2>
    <p>Hi ${fullName},</p>
    <p>Use the code below to reset your GalleryQ password:</p>
    <p style="text-align: center; margin: 32px 0;">
      <span style="font-size: 32px; font-weight: 700; letter-spacing: 8px; background: #f3f4f6; padding: 12px 24px; border-radius: 8px; display: inline-block;">
        ${code}
      </span>
    </p>
    <p style="font-size: 13px; color: #6b7280;">
      This code expires shortly. If you didn't request a password reset, you can safely ignore this email.
    </p>
  </div>`;
  }

  private buildAuctionApprovedHtml(
    fullName: string,
    auctionTitle: string,
  ): string {
    return `
  <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
    <h2 style="margin: 0 0 16px;">Bid Smart. Win Big.</h2>
    <p>Hi ${fullName},</p>
    <p>Your auction <strong>${auctionTitle}</strong> has been approved and is now
      <strong>live</strong> on GalleryQ. Buyers can start bidding right away.</p>
    <p style="font-size: 13px; color: #6b7280;">Good luck with your auction!</p>
  </div>`;
  }

  private buildAuctionRejectedHtml(
    fullName: string,
    auctionTitle: string,
    reason: string,
  ): string {
    return `
  <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
    <h2 style="margin: 0 0 16px;">Bid Smart. Win Big.</h2>
    <p>Hi ${fullName},</p>
    <p>Your auction <strong>${auctionTitle}</strong> was not approved.</p>
    <p style="background: #fef2f2; border-radius: 8px; padding: 12px 16px; color: #991b1b;">
      <strong>Reason:</strong> ${reason}
    </p>
    <p style="font-size: 13px; color: #6b7280;">
      You can edit the auction in the app and resubmit it for review.
    </p>
  </div>`;
  }

  private buildVerificationCodeHtml(fullName: string, code: string): string {
    return `
  <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
    <h2 style="margin: 0 0 16px;">Bid Smart. Win Big.</h2>
    <p>Hi ${fullName},</p>
    <p>Use the code below to verify your email and finish creating your GalleryQ account:</p>
    <p style="text-align: center; margin: 32px 0;">
      <span style="font-size: 32px; font-weight: 700; letter-spacing: 8px; background: #f3f4f6; padding: 12px 24px; border-radius: 8px; display: inline-block;">
        ${code}
      </span>
    </p>
    <p style="font-size: 13px; color: #6b7280;">
      This code expires shortly. If you didn't sign up, you can safely ignore this email.
    </p>
  </div>`;
  }
}
