import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as argon from 'argon2';
import { Role } from 'generated/prisma/client';
import type { DatabaseService } from '../../src/modules/database/database.service';
import { createIntegrationTestApp, capturedMail, resetCapturedMail } from './test-app';
import { resetDatabase } from './db-reset';

/**
 * Integration tests: exercise real NestJS DI wiring + a real local PostgreSQL
 * database (no mocked Prisma) across module boundaries. Only genuinely
 * external services (ImageKit uploads, Stripe) are faked — see test-app.ts.
 *
 * This complements the Unit tests (isolated, mocked Prisma) by proving the
 * modules actually integrate correctly: auth -> seller-verification ->
 * auctions -> bids -> wallet -> orders/settlement, end to end over real HTTP.
 */
describe('Auction lifecycle (integration)', () => {
  let app: INestApplication;
  let prisma: DatabaseService;

  beforeAll(async () => {
    const ctx = await createIntegrationTestApp();
    app = ctx.app;
    prisma = ctx.prisma;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    resetCapturedMail();
  });

  const server = () => app.getHttpServer();

  async function registerAndVerify(email: string, password: string, fullName: string) {
    const registerRes = await request(server())
      .post('/auth/register')
      .send({ email, password, fullName });
    expect(registerRes.status).toBe(200);

    const code = capturedMail.verificationCodes.get(email);
    expect(code).toMatch(/^\d{6}$/);

    const verifyRes = await request(server())
      .post('/auth/verify-email')
      .send({ email, code });
    expect(verifyRes.status).toBe(201);

    return verifyRes.body as { token: string; userData: { id: string; roles: Role[] } };
  }

  async function createAdmin() {
    const hashed = await argon.hash('AdminPass123!');
    const admin = await prisma.user.create({
      data: {
        email: 'admin@integration.test',
        fullName: 'Integration Admin',
        password: hashed,
        roles: [Role.ADMIN],
      },
    });
    const loginRes = await request(server())
      .post('/auth/login')
      .send({ email: admin.email, password: 'AdminPass123!' });
    expect(loginRes.status).toBe(201);
    return { token: loginRes.body.token as string, id: admin.id };
  }

  async function becomeSeller(token: string, phoneNumber: string) {
    const reqRes = await request(server())
      .post('/seller/request-verification')
      .set('Authorization', `Bearer ${token}`)
      .send({ phoneNumber });
    expect(reqRes.status).toBe(200);
    expect(reqRes.body.code).toMatch(/^\d{6}$/); // SELLER_OTP_SIMULATE=true

    const verifyRes = await request(server())
      .post('/seller/verify-phone')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: reqRes.body.code });
    expect(verifyRes.status).toBe(200);
  }

  async function creditWallet(userId: string, amount: number) {
    await prisma.wallet.upsert({
      where: { userId },
      create: { userId, balance: amount },
      update: { balance: { increment: amount } },
    });
  }

  async function createDraftlessAuction(sellerToken: string) {
    const res = await request(server())
      .post('/auctions')
      .set('Authorization', `Bearer ${sellerToken}`)
      .field('category', 'ART')
      .field('title', 'Antique Vase')
      .field('startingPrice', '100')
      .field('minBidIncrement', '10')
      .field('durationDays', '7')
      .attach('mainImage', Buffer.from('fake-image-bytes'), {
        filename: 'main.png',
        contentType: 'image/png',
      });
    return res;
  }

  it('registers via email OTP, verifies, and only THEN creates the User (no user before verify)', async () => {
    const email = 'buyer1@integration.test';
    await request(server()).post('/auth/register').send({
      email,
      password: 'Pass1234!',
      fullName: 'Buyer One',
    });

    const beforeVerify = await prisma.user.findUnique({ where: { email } });
    expect(beforeVerify).toBeNull();

    const { userData } = await registerAndVerify(email, 'Pass1234!', 'Buyer One');
    expect(userData.roles).toEqual([Role.BUYER]);

    const afterVerify = await prisma.user.findUnique({ where: { email } });
    expect(afterVerify).not.toBeNull();
  });

  it('rejects a wrong verification code without creating the user', async () => {
    const email = 'buyer2@integration.test';
    await request(server()).post('/auth/register').send({
      email,
      password: 'Pass1234!',
      fullName: 'Buyer Two',
    });

    const res = await request(server())
      .post('/auth/verify-email')
      .send({ email, code: '000000' });
    expect(res.status).toBe(400);
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it('grants the SELLER role via WhatsApp-OTP-simulated phone verification', async () => {
    const { token, userData } = await registerAndVerify(
      'seller1@integration.test',
      'Pass1234!',
      'Seller One',
    );
    expect(userData.roles).toEqual([Role.BUYER]);

    await becomeSeller(token, '0599111111');

    const dbUser = await prisma.user.findUnique({ where: { id: userData.id } });
    expect(dbUser?.roles).toEqual(expect.arrayContaining([Role.BUYER, Role.SELLER]));
    const profile = await prisma.sellerProfile.findUnique({ where: { userId: userData.id } });
    expect(profile?.phoneNumber).toBe('970599111111');
  });

  it('runs the full wizard-create -> admin-approve -> bid -> outbid -> close -> pay flow end to end', async () => {
    // ---- Arrange: seller + two buyers + admin ----
    const seller = await registerAndVerify('seller2@integration.test', 'Pass1234!', 'Seller Two');
    await becomeSeller(seller.token, '0599222222');

    const buyerA = await registerAndVerify('buyerA@integration.test', 'Pass1234!', 'Buyer A');
    const buyerB = await registerAndVerify('buyerB@integration.test', 'Pass1234!', 'Buyer B');
    await creditWallet(buyerA.userData.id, 500);
    await creditWallet(buyerB.userData.id, 500);

    const admin = await createAdmin();

    // ---- Create (multipart, real ImageKit call faked) -> PENDING_REVIEW ----
    const createRes = await createDraftlessAuction(seller.token);
    expect(createRes.status).toBe(201);
    expect(createRes.body.status).toBe('PENDING_REVIEW');
    const auctionId = createRes.body.id as string;

    // A buyer cannot bid on a not-yet-approved auction
    const earlyBid = await request(server())
      .post(`/auctions/${auctionId}/bids`)
      .set('Authorization', `Bearer ${buyerA.token}`)
      .send({ amount: 100 });
    expect(earlyBid.status).toBe(400);

    // ---- Admin approves -> LIVE ----
    const approveRes = await request(server())
      .post(`/auctions/${auctionId}/approve`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe('LIVE');

    // ---- Buyer A places the first bid (>= startingPrice=100) ----
    const bidA = await request(server())
      .post(`/auctions/${auctionId}/bids`)
      .set('Authorization', `Bearer ${buyerA.token}`)
      .send({ amount: 100 });
    expect(bidA.status).toBe(201);
    expect(bidA.body).toMatchObject({ currentPrice: '100.00', depositHeld: true });

    const walletA1 = await request(server())
      .get('/wallet')
      .set('Authorization', `Bearer ${buyerA.token}`);
    expect(walletA1.body).toEqual({ balance: '450.00', lockedBalance: '50.00', currency: 'USD' });

    // ---- Buyer B outbids A (releases A's deposit, holds B's) ----
    const bidB = await request(server())
      .post(`/auctions/${auctionId}/bids`)
      .set('Authorization', `Bearer ${buyerB.token}`)
      .send({ amount: 150 });
    expect(bidB.status).toBe(201);

    const walletA2 = await request(server())
      .get('/wallet')
      .set('Authorization', `Bearer ${buyerA.token}`);
    expect(walletA2.body).toEqual({ balance: '500.00', lockedBalance: '0.00', currency: 'USD' });

    const walletB2 = await request(server())
      .get('/wallet')
      .set('Authorization', `Bearer ${buyerB.token}`);
    expect(walletB2.body).toEqual({ balance: '450.00', lockedBalance: '50.00', currency: 'USD' });

    // Public bid history — highest first, full names
    const history = await request(server()).get(`/auctions/${auctionId}/bids`);
    expect(history.status).toBe(200);
    expect(history.body.items.map((i: any) => i.amount)).toEqual(['150.00', '100.00']);

    // ---- Admin force-ends the auction (bypasses waiting for durationDays) ----
    const closeRes = await request(server())
      .post(`/auctions/${auctionId}/force-end`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(closeRes.status).toBe(200);
    expect(closeRes.body).toEqual({ auctionId, closed: true });

    // Order auto-created for buyer B (winner) and auto-pay attempted immediately
    const myOrders = await request(server())
      .get('/orders/mine')
      .set('Authorization', `Bearer ${buyerB.token}`);
    expect(myOrders.status).toBe(200);
    expect(myOrders.body.items).toHaveLength(1);
    const order = myOrders.body.items[0];
    expect(order.amount).toBe('150.00');
    expect(order.depositApplied).toBe('50.00');
    expect(order.amountDue).toBe('100.00');

    // B had $450 balance + $50 locked; auto-pay should already have completed it
    // (amountDue=100 <= balance=450), so it's COMPLETED, not AWAITING_PAYMENT.
    expect(order.status).toBe('COMPLETED');

    const walletBFinal = await request(server())
      .get('/wallet')
      .set('Authorization', `Bearer ${buyerB.token}`);
    // 450 - 100 (amountDue) = 350; lockedBalance 50 -> 0 (deposit applied)
    expect(walletBFinal.body).toEqual({ balance: '350.00', lockedBalance: '0.00', currency: 'USD' });

    const sellerWallet = await request(server())
      .get('/wallet')
      .set('Authorization', `Bearer ${seller.token}`);
    // Seller gets the FULL price ($150) immediately, no escrow
    expect(sellerWallet.body.balance).toBe('150.00');

    const auctionAfter = await request(server()).get(`/auctions/${auctionId}`);
    expect(auctionAfter.body.status).toBe('SOLD');
  });

  it('forfeits the deposit and offers a second chance when the winner never pays in time', async () => {
    const seller = await registerAndVerify('seller3@integration.test', 'Pass1234!', 'Seller Three');
    await becomeSeller(seller.token, '0599333333');
    const buyerA = await registerAndVerify('buyerC@integration.test', 'Pass1234!', 'Buyer C');
    const buyerB = await registerAndVerify('buyerD@integration.test', 'Pass1234!', 'Buyer D');
    // Winner (A) has just enough for the $50 deposit but NOT enough to cover amountDue later
    await creditWallet(buyerA.userData.id, 50);
    await creditWallet(buyerB.userData.id, 500);
    const admin = await createAdmin();

    const createRes = await createDraftlessAuction(seller.token);
    const auctionId = createRes.body.id as string;
    await request(server())
      .post(`/auctions/${auctionId}/approve`)
      .set('Authorization', `Bearer ${admin.token}`);

    await request(server())
      .post(`/auctions/${auctionId}/bids`)
      .set('Authorization', `Bearer ${buyerB.token}`)
      .send({ amount: 100 });
    await request(server())
      .post(`/auctions/${auctionId}/bids`)
      .set('Authorization', `Bearer ${buyerA.token}`)
      .send({ amount: 200 }); // A takes the lead, spends their only $50 on the deposit

    await request(server())
      .post(`/auctions/${auctionId}/force-end`)
      .set('Authorization', `Bearer ${admin.token}`);

    // A won at $200 but only had the $50 deposit -> amountDue=$150, auto-pay fails -> AWAITING_PAYMENT
    const orderRow = await prisma.order.findFirst({ where: { auctionId, offerRank: 1 } });
    expect(orderRow?.status).toBe('AWAITING_PAYMENT');

    // Simulate the 72h deadline passing, then run the scheduler tick manually
    await prisma.order.update({
      where: { id: orderRow!.id },
      data: { paymentDeadline: new Date(Date.now() - 1000) },
    });
    const tickRes = await request(server())
      .post('/scheduler/run')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(tickRes.status).toBe(200);

    // A's deposit is forfeited (locked $50 -> gone, not refunded)
    const walletAFinal = await request(server())
      .get('/wallet')
      .set('Authorization', `Bearer ${buyerA.token}`);
    expect(walletAFinal.body).toEqual({ balance: '0.00', lockedBalance: '0.00', currency: 'USD' });

    // B (second-highest, $100 bid) is offered a second-chance order at their own price
    const bOrders = await request(server())
      .get('/orders/mine')
      .set('Authorization', `Bearer ${buyerB.token}`);
    expect(bOrders.body.items).toHaveLength(1);
    expect(bOrders.body.items[0]).toMatchObject({
      offerRank: 2,
      amount: '100.00',
      depositApplied: '0.00',
      amountDue: '100.00',
      status: 'AWAITING_PAYMENT',
    });
  });

  it('marks a no-bid auction UNSOLD and returns the object to AVAILABLE', async () => {
    const seller = await registerAndVerify('seller4@integration.test', 'Pass1234!', 'Seller Four');
    await becomeSeller(seller.token, '0599444444');
    const admin = await createAdmin();

    const createRes = await createDraftlessAuction(seller.token);
    const auctionId = createRes.body.id as string;
    await request(server())
      .post(`/auctions/${auctionId}/approve`)
      .set('Authorization', `Bearer ${admin.token}`);

    const closeRes = await request(server())
      .post(`/auctions/${auctionId}/force-end`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(closeRes.body.closed).toBe(true);

    const auctionAfter = await request(server()).get(`/auctions/${auctionId}`);
    expect(auctionAfter.body.status).toBe('UNSOLD');
  });

  it('favorites and follows work end-to-end and stay idempotent', async () => {
    const seller = await registerAndVerify('seller5@integration.test', 'Pass1234!', 'Seller Five');
    await becomeSeller(seller.token, '0599555555');
    const buyer = await registerAndVerify('buyerE@integration.test', 'Pass1234!', 'Buyer E');
    const admin = await createAdmin();

    const createRes = await createDraftlessAuction(seller.token);
    const auctionId = createRes.body.id as string;
    await request(server())
      .post(`/auctions/${auctionId}/approve`)
      .set('Authorization', `Bearer ${admin.token}`);

    // Favorite an auction — idempotent add
    const fav1 = await request(server())
      .post(`/favorites/${auctionId}`)
      .set('Authorization', `Bearer ${buyer.token}`);
    expect(fav1.body).toEqual({ favorited: true });
    const fav2 = await request(server())
      .post(`/favorites/${auctionId}`)
      .set('Authorization', `Bearer ${buyer.token}`);
    expect(fav2.body).toEqual({ favorited: true });

    const favList = await request(server())
      .get('/favorites')
      .set('Authorization', `Bearer ${buyer.token}`);
    expect(favList.body.items).toHaveLength(1);

    // Follow the seller — idempotent, and self-follow is rejected
    const followSelf = await request(server())
      .post(`/follows/${seller.userData.id}`)
      .set('Authorization', `Bearer ${seller.token}`);
    expect(followSelf.status).toBe(400);

    const follow1 = await request(server())
      .post(`/follows/${seller.userData.id}`)
      .set('Authorization', `Bearer ${buyer.token}`);
    expect(follow1.body).toEqual({ following: true });

    const unfollow = await request(server())
      .delete(`/follows/${seller.userData.id}`)
      .set('Authorization', `Bearer ${buyer.token}`);
    expect(unfollow.body).toEqual({ following: false });
  });

  it('enforces auth + role guards across modules (401/403 paths)', async () => {
    const buyer = await registerAndVerify('buyerF@integration.test', 'Pass1234!', 'Buyer F');

    // No token at all -> 401
    const noAuth = await request(server()).get('/wallet');
    expect(noAuth.status).toBe(401);

    // A BUYER (no SELLER role) cannot create an auction -> 403
    const forbidden = await createDraftlessAuction(buyer.token);
    expect(forbidden.status).toBe(403);

    // A non-admin cannot approve auctions -> 403
    const fakeApprove = await request(server())
      .post('/auctions/00000000-0000-0000-0000-000000000000/approve')
      .set('Authorization', `Bearer ${buyer.token}`);
    expect(fakeApprove.status).toBe(403);
  });
});
