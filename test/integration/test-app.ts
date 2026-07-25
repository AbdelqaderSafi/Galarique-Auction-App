import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { DatabaseService } from '../../src/modules/database/database.service';
import { UploadsService } from '../../src/modules/uploads/uploads.service';
import { StripeService } from '../../src/modules/wallet/stripe.service';
import { MailService } from '../../src/modules/mail/mail.service';

let counter = 0;

// Codes/links MailService "sends" are captured here instead of going over the
// network — integration tests read them back (e.g. to complete a signup or a
// password reset) instead of scraping log lines.
export const capturedMail = {
  verificationCodes: new Map<string, string>(), // email -> 6-digit code
  passwordResetCodes: new Map<string, string>(),
};

export function resetCapturedMail(): void {
  capturedMail.verificationCodes.clear();
  capturedMail.passwordResetCodes.clear();
}

const fakeMailService: Partial<MailService> = {
  sendEmailVerificationCode: async (to, _fullName, code) => {
    capturedMail.verificationCodes.set(to, code);
  },
  sendPasswordResetCode: async (to, _fullName, code) => {
    capturedMail.passwordResetCodes.set(to, code);
  },
  sendAuctionApproved: async () => undefined,
  sendAuctionRejected: async () => undefined,
  sendOutbid: async () => undefined,
  sendPaymentRequired: async () => undefined,
  sendOrderPaid: async () => undefined,
  sendItemSold: async () => undefined,
  sendSecondChance: async () => undefined,
  sendAuctionUnsold: async () => undefined,
};

// Uploads/Stripe are hard external dependencies (ImageKit/Stripe network calls).
// Integration tests replace them with deterministic in-memory fakes so the
// suite is hermetic and can run with no internet connection.
const fakeUploadsService: Partial<UploadsService> = {
  uploadImage: async (file) => ({
    url: `https://fake-cdn.test/${Date.now()}-${counter++}-${file?.originalname ?? 'file'}`,
    fileId: `fake-${counter}`,
    name: file?.originalname ?? 'file',
    thumbnailUrl: 'https://fake-cdn.test/thumb.jpg',
  }),
  uploadImages: async (files) =>
    (files ?? []).map((f, i) => ({
      url: `https://fake-cdn.test/${Date.now()}-${counter++}-${i}-${f.originalname}`,
      fileId: `fake-${counter}-${i}`,
      name: f.originalname,
      thumbnailUrl: 'https://fake-cdn.test/thumb.jpg',
    })),
  deleteImage: async () => undefined,
};

const fakeStripeService: Partial<StripeService> = {
  createCheckoutSession: async () =>
    ({ url: 'https://checkout.stripe.test/fake-session' }) as any,
  retrieveCheckoutSession: async () => ({}) as any,
  constructEvent: () => {
    throw new Error('StripeService.constructEvent is not exercised in integration tests');
  },
  createConnectAccount: async () => ({ id: 'acct_fake' }) as any,
  createAccountLink: async () => ({ url: 'https://connect.stripe.test/fake' }) as any,
  retrieveAccount: async () => ({ payouts_enabled: true, charges_enabled: true, details_submitted: true }) as any,
  createTransfer: async () => ({ id: 'tr_fake' }) as any,
};

export async function createIntegrationTestApp(): Promise<{
  app: INestApplication;
  prisma: DatabaseService;
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(UploadsService)
    .useValue(fakeUploadsService)
    .overrideProvider(StripeService)
    .useValue(fakeStripeService)
    .overrideProvider(MailService)
    .useValue(fakeMailService)
    .compile();

  const app = moduleRef.createNestApplication();
  await app.init();

  const prisma = app.get(DatabaseService);
  return { app, prisma };
}
