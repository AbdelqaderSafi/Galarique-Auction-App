import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import * as argon from 'argon2';

/**
 * Seeds test data for exercising the bids module over real HTTP.
 * Creates: a seller, three buyers (A/B with $100 wallets, C with $20),
 * a LIVE auction (startingPrice 100, minBidIncrement 50) and a DRAFT auction.
 * Idempotent: cleans up its own prior rows first. Dev DB only.
 *
 * Prints a JSON blob of ids/emails to stdout (last line) for the test runner.
 */
const PASSWORD = 'Test1234!';

const USERS = {
  seller: { email: 'seller.bids@test.local', roles: ['SELLER'] },
  buyerA: { email: 'buyerA.bids@test.local', roles: ['BUYER'] },
  buyerB: { email: 'buyerB.bids@test.local', roles: ['BUYER'] },
  buyerC: { email: 'buyerC.bids@test.local', roles: ['BUYER'] },
};

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
  const buyerCId = await upsertUser(client, USERS.buyerC.email, USERS.buyerC.roles, hashed);
  const allUsers = [sellerId, buyerAId, buyerBId, buyerCId];

  // 2) cleanup prior test rows (order respects FKs; auction delete cascades bids/deposits)
  await client.query(
    `DELETE FROM "WalletTransaction" WHERE "walletId" IN (SELECT id FROM "Wallet" WHERE "userId" = ANY($1));`,
    [allUsers],
  );
  await client.query(`DELETE FROM "Wallet" WHERE "userId" = ANY($1);`, [allUsers]);
  await client.query(
    `DELETE FROM "Auction" WHERE "objectId" IN (SELECT id FROM "Object" WHERE "ownerId" = $1);`,
    [sellerId],
  );
  await client.query(`DELETE FROM "Object" WHERE "ownerId" = $1;`, [sellerId]);

  // 3) wallets: A/B fundable ($100), C too low ($20)
  const mkWallet = (userId: string, balance: number) =>
    client.query(
      `INSERT INTO "Wallet" ("id","userId","balance","lockedBalance","createdAt","updatedAt")
       VALUES ($1,$2,$3,0,now(),now());`,
      [randomUUID(), userId, balance],
    );
  await mkWallet(buyerAId, 100);
  await mkWallet(buyerBId, 100);
  await mkWallet(buyerCId, 20);

  // 4) LIVE auction (startingPrice 100, minBidIncrement 50)
  const liveObjId = randomUUID();
  await client.query(
    `INSERT INTO "Object" ("id","ownerId","category","title","mainImage","status","createdAt","updatedAt")
     VALUES ($1,$2,'ART','[TEST] Live Painting','https://ik.imagekit.io/test/live.jpg','IN_AUCTION',now(),now());`,
    [liveObjId, sellerId],
  );
  const liveAuctionId = randomUUID();
  await client.query(
    `INSERT INTO "Auction"
       ("id","objectId","startingPrice","minBidIncrement","currentPrice","durationDays",
        "startTime","endTime","antiSnipeSeconds","extendBySeconds","viewsCount","status","createdAt","updatedAt")
     VALUES ($1,$2,100,50,0,1, now(), now() + interval '1 day', 60,60,0,'LIVE',now(),now());`,
    [liveAuctionId, liveObjId],
  );

  // 5) DRAFT auction (for "auction not live" + non-public history 404)
  const draftObjId = randomUUID();
  await client.query(
    `INSERT INTO "Object" ("id","ownerId","category","title","mainImage","status","createdAt","updatedAt")
     VALUES ($1,$2,'ART','[TEST] Draft Painting','https://ik.imagekit.io/test/draft.jpg','DRAFT',now(),now());`,
    [draftObjId, sellerId],
  );
  const draftAuctionId = randomUUID();
  await client.query(
    `INSERT INTO "Auction"
       ("id","objectId","startingPrice","minBidIncrement","currentPrice","durationDays",
        "antiSnipeSeconds","extendBySeconds","viewsCount","status","createdAt","updatedAt")
     VALUES ($1,$2,100,50,0,1,60,60,0,'DRAFT',now(),now());`,
    [draftAuctionId, draftObjId],
  );

  await client.end();

  const out = {
    password: PASSWORD,
    emails: {
      seller: USERS.seller.email,
      buyerA: USERS.buyerA.email,
      buyerB: USERS.buyerB.email,
      buyerC: USERS.buyerC.email,
    },
    sellerId,
    buyerAId,
    buyerBId,
    buyerCId,
    liveAuctionId,
    draftAuctionId,
  };
  console.log('SEED_RESULT ' + JSON.stringify(out));
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
