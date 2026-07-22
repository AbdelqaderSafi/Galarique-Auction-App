import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import * as argon from 'argon2';
import jwt from 'jsonwebtoken';

/**
 * Seeds test data for exercising the realtime SSE module (Task 5) over real HTTP.
 * Creates: a seller (with SellerProfile), two funded buyers A/B ($100 wallets each,
 * so the $50 bid deposit always holds), one LIVE auction with a normal endTime
 * (startingPrice 100, minBidIncrement 10, currentPrice 0 — for the bid/outbid
 * live-stream assertions), and a second short-lived LIVE auction with
 * antiSnipeSeconds=0 and an endTime a few seconds out (for the optional
 * closed/won broadcast test — the scheduler will find it due almost immediately).
 *
 * Mints JWTs directly (jsonwebtoken, same JWT_SECRET + { sub, roles } payload
 * shape as AuthService.signToken) so the test script doesn't need to log in.
 *
 * Idempotent: cleans up its own prior rows first. Dev DB only.
 */
const PASSWORD = 'Test1234!';

const USERS = {
  seller: { email: 'seller.rt@test.local', roles: ['SELLER'] },
  buyerA: { email: 'buyerA.rt@test.local', roles: ['BUYER'] },
  buyerB: { email: 'buyerB.rt@test.local', roles: ['BUYER'] },
};

function mintToken(userId: string, roles: string[]): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET not set in env');
  return jwt.sign({ sub: userId, roles }, secret, { expiresIn: '30d' });
}

async function upsertUser(
  client: Client,
  email: string,
  roles: string[],
  hashed: string,
): Promise<string> {
  const rolesLiteral = `ARRAY[${roles.map((r) => `'${r}'`).join(',')}]::"Role"[]`;
  const res = await client.query(
    `INSERT INTO "User"
       ("id","fullName","email","password","provider","roles","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,'LOCAL',${rolesLiteral},now(),now())
     ON CONFLICT ("email") DO UPDATE
       SET "password" = EXCLUDED."password",
           "roles" = ${rolesLiteral},
           "updatedAt" = now()
     RETURNING "id";`,
    [randomUUID(), email.split('@')[0], email, hashed],
  );
  return res.rows[0].id as string;
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const hashed = await argon.hash(PASSWORD);

  // 1) users
  const sellerId = await upsertUser(client, USERS.seller.email, USERS.seller.roles, hashed);
  const buyerAId = await upsertUser(client, USERS.buyerA.email, USERS.buyerA.roles, hashed);
  const buyerBId = await upsertUser(client, USERS.buyerB.email, USERS.buyerB.roles, hashed);
  const allUsers = [sellerId, buyerAId, buyerBId];

  // 2) cleanup prior test rows (order respects FKs; auction delete cascades bids/deposits)
  await client.query(
    `DELETE FROM "WalletTransaction" WHERE "walletId" IN (SELECT id FROM "Wallet" WHERE "userId" = ANY($1));`,
    [allUsers],
  );
  await client.query(`DELETE FROM "Wallet" WHERE "userId" = ANY($1);`, [allUsers]);
  await client.query(
    `DELETE FROM "Order" WHERE "auctionId" IN (SELECT id FROM "Auction" WHERE "objectId" IN (SELECT id FROM "Object" WHERE "ownerId" = $1));`,
    [sellerId],
  );
  await client.query(
    `DELETE FROM "Auction" WHERE "objectId" IN (SELECT id FROM "Object" WHERE "ownerId" = $1);`,
    [sellerId],
  );
  await client.query(`DELETE FROM "Object" WHERE "ownerId" = $1;`, [sellerId]);
  await client.query(`DELETE FROM "SellerProfile" WHERE "userId" = $1;`, [sellerId]);

  // 3) seller profile (not strictly required for bidding, but keeps the seller a real SELLER)
  await client.query(
    `INSERT INTO "SellerProfile" ("id","userId","phoneNumber","phoneVerifiedAt","createdAt","updatedAt")
     VALUES ($1,$2,$3,now(),now(),now());`,
    [randomUUID(), sellerId, '+970599' + Math.floor(100000 + Math.random() * 899999)],
  );

  // 4) wallets: A/B funded with $100 (>= $100 so the $50 deposit always holds)
  const mkWallet = (userId: string, balance: number) =>
    client.query(
      `INSERT INTO "Wallet" ("id","userId","balance","lockedBalance","createdAt","updatedAt")
       VALUES ($1,$2,$3,0,now(),now());`,
      [randomUUID(), userId, balance],
    );
  await mkWallet(buyerAId, 100);
  await mkWallet(buyerBId, 100);

  // 5) main LIVE auction — normal endTime a few minutes out, for bid/outbid streaming
  const mainObjId = randomUUID();
  await client.query(
    `INSERT INTO "Object" ("id","ownerId","category","title","mainImage","status","createdAt","updatedAt")
     VALUES ($1,$2,'ART','[TEST] Realtime Live Auction','https://ik.imagekit.io/test/rt-live.jpg','IN_AUCTION',now(),now());`,
    [mainObjId, sellerId],
  );
  const auctionId = randomUUID();
  await client.query(
    `INSERT INTO "Auction"
       ("id","objectId","startingPrice","minBidIncrement","currentPrice","durationDays",
        "startTime","endTime","antiSnipeSeconds","extendBySeconds","viewsCount","status","createdAt","updatedAt")
     VALUES ($1,$2,100,10,0,1, now(), now() + interval '10 minutes', 60,60,0,'LIVE',now(),now());`,
    [auctionId, mainObjId],
  );

  // 6) second LIVE auction dedicated to the optional closed/won broadcast test.
  // endTime is set generously far out (5 min) so the winning bid always succeeds
  // regardless of how much wall-clock time elapses between running this seed and
  // running the test (server boot, manual copy/paste, etc.) — the test script
  // itself forces this auction's endTime into the past (direct SQL, per the
  // task brief) right before triggering the scheduler, so there's no race with
  // the background cron closing it out from under us.
  const closeObjId = randomUUID();
  await client.query(
    `INSERT INTO "Object" ("id","ownerId","category","title","mainImage","status","createdAt","updatedAt")
     VALUES ($1,$2,'ART','[TEST] Realtime Close Auction','https://ik.imagekit.io/test/rt-close.jpg','IN_AUCTION',now(),now());`,
    [closeObjId, sellerId],
  );
  const closeAuctionId = randomUUID();
  await client.query(
    `INSERT INTO "Auction"
       ("id","objectId","startingPrice","minBidIncrement","currentPrice","durationDays",
        "startTime","endTime","antiSnipeSeconds","extendBySeconds","viewsCount","status","createdAt","updatedAt")
     VALUES ($1,$2,100,10,0,1, now(), now() + interval '5 minutes', 0,0,0,'LIVE',now(),now());`,
    [closeAuctionId, closeObjId],
  );

  await client.end();

  const tokenA = mintToken(buyerAId, ['BUYER']);
  const tokenB = mintToken(buyerBId, ['BUYER']);

  const out = {
    password: PASSWORD,
    emails: { seller: USERS.seller.email, buyerA: USERS.buyerA.email, buyerB: USERS.buyerB.email },
    sellerId,
    userAId: buyerAId,
    userBId: buyerBId,
    auctionId,
    closeAuctionId,
    tokenA,
    tokenB,
  };
  console.log('SEED_RESULT ' + JSON.stringify(out));
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
