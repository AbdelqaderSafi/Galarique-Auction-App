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

  async sendOutbid(
    to: string,
    fullName: string,
    auctionTitle: string,
    newPrice: string,
  ): Promise<void> {
    const subject = `You've been outbid on ${auctionTitle}`;
    const html = this.buildOutbidHtml(fullName, auctionTitle, newPrice);
    const text =
      `Hi ${fullName},\n\n` +
      `Someone placed a higher bid on "${auctionTitle}".\n` +
      `The current bid is now $${newPrice}.\n\n` +
      `Place a higher bid in the app to take the lead again.\n\n` +
      `Bid Smart. Win Big.`;

    await this.send({ to, subject, html, text });
  }

  async sendPaymentRequired(
    to: string,
    fullName: string,
    auctionTitle: string,
    amountDue: string,
    deadline: Date,
  ): Promise<void> {
    const subject = `You won ${auctionTitle} — payment needed`;
    const html = this.buildSettlementHtml(
      fullName,
      `You won <strong>${auctionTitle}</strong>! Your $50 deposit covers part of it — <strong>$${amountDue}</strong> is still due.`,
      `Top up your wallet and pay before ${deadline.toUTCString()}, or the item goes to the next bidder and your deposit is forfeited.`,
      '#fff7ed',
      '#9a3412',
    );
    const text =
      `Hi ${fullName},\n\n` +
      `You won "${auctionTitle}". Amount due: $${amountDue}.\n` +
      `Pay from your wallet before ${deadline.toUTCString()}, or the item is offered to the next bidder and your $50 deposit is forfeited.\n\n` +
      `Bid Smart. Win Big.`;
    await this.send({ to, subject, html, text });
  }

  async sendOrderPaid(
    to: string,
    fullName: string,
    auctionTitle: string,
    amount: string,
  ): Promise<void> {
    const subject = `You won ${auctionTitle} — payment complete`;
    const html = this.buildSettlementHtml(
      fullName,
      `Congratulations — <strong>${auctionTitle}</strong> is yours for <strong>$${amount}</strong>.`,
      'Payment is complete. Contact the seller by email to arrange the handover.',
      '#f0fdf4',
      '#166534',
    );
    const text =
      `Hi ${fullName},\n\n` +
      `You won "${auctionTitle}" for $${amount} and payment is complete.\n` +
      `Contact the seller by email to arrange the handover.\n\n` +
      `Bid Smart. Win Big.`;
    await this.send({ to, subject, html, text });
  }

  async sendItemSold(
    to: string,
    fullName: string,
    auctionTitle: string,
    amount: string,
    buyerEmail: string,
  ): Promise<void> {
    const subject = `Your item sold: ${auctionTitle}`;
    const html = this.buildSettlementHtml(
      fullName,
      `<strong>${auctionTitle}</strong> sold for <strong>$${amount}</strong> — the funds are in your wallet.`,
      `Contact the buyer at <a href="mailto:${buyerEmail}">${buyerEmail}</a> to arrange the handover.`,
      '#f0fdf4',
      '#166534',
    );
    const text =
      `Hi ${fullName},\n\n` +
      `"${auctionTitle}" sold for $${amount}. The funds are in your wallet.\n` +
      `Contact the buyer at ${buyerEmail} to arrange the handover.\n\n` +
      `Bid Smart. Win Big.`;
    await this.send({ to, subject, html, text });
  }

  async sendSecondChance(
    to: string,
    fullName: string,
    auctionTitle: string,
    amount: string,
    deadline: Date,
  ): Promise<void> {
    const subject = `Second chance: ${auctionTitle} is available`;
    const html = this.buildSettlementHtml(
      fullName,
      `The winning bidder for <strong>${auctionTitle}</strong> didn't pay — it's yours at your bid of <strong>$${amount}</strong> if you want it.`,
      `This offer is optional. Pay from your wallet before ${deadline.toUTCString()} to claim it; ignore it and nothing happens.`,
      '#eff6ff',
      '#1e40af',
    );
    const text =
      `Hi ${fullName},\n\n` +
      `The winning bidder for "${auctionTitle}" didn't pay. You can buy it at your bid of $${amount}.\n` +
      `This is optional — pay from your wallet before ${deadline.toUTCString()} to claim it.\n\n` +
      `Bid Smart. Win Big.`;
    await this.send({ to, subject, html, text });
  }

  async sendAuctionUnsold(
    to: string,
    fullName: string,
    auctionTitle: string,
  ): Promise<void> {
    const subject = `Your auction ended unsold: ${auctionTitle}`;
    const html = this.buildSettlementHtml(
      fullName,
      `<strong>${auctionTitle}</strong> ended without a completed sale.`,
      'The item is back in your collection — you can list it again any time.',
      '#f3f4f6',
      '#374151',
    );
    const text =
      `Hi ${fullName},\n\n` +
      `"${auctionTitle}" ended without a completed sale. The item is back in your collection and you can list it again any time.\n\n` +
      `Bid Smart. Win Big.`;
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

  private buildOutbidHtml(
    fullName: string,
    auctionTitle: string,
    newPrice: string,
  ): string {
    return `
  <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
    <h2 style="margin: 0 0 16px;">Bid Smart. Win Big.</h2>
    <p>Hi ${fullName},</p>
    <p>You've been outbid on <strong>${auctionTitle}</strong>.</p>
    <p style="background: #fff7ed; border-radius: 8px; padding: 12px 16px; color: #9a3412;">
      The current bid is now <strong>$${newPrice}</strong>.
    </p>
    <p style="font-size: 13px; color: #6b7280;">
      Place a higher bid in the app to take the lead again.
    </p>
  </div>`;
  }

  private buildSettlementHtml(
    fullName: string,
    lead: string,
    calloutHtml: string,
    calloutBg: string,
    calloutColor: string,
  ): string {
    return `
  <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
    <h2 style="margin: 0 0 16px;">Bid Smart. Win Big.</h2>
    <p>Hi ${fullName},</p>
    <p>${lead}</p>
    <p style="background: ${calloutBg}; border-radius: 8px; padding: 12px 16px; color: ${calloutColor};">
      ${calloutHtml}
    </p>
    <p style="font-size: 13px; color: #6b7280;">GalleryQ</p>
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
