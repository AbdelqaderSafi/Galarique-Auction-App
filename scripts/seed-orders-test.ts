import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import * as argon from 'argon2';

/**
 * Seeds test data for exercising the scheduler + orders modules over real HTTP.
 * Creates a seller + 8 buyer-role test users, funds their wallets, and seeds 7 LIVE
 * auctions already past endTime (already due) covering every settlement scenario:
 *   1. no-bids            -> closes to UNSOLD
 *   2. funded-winner      -> closes, auto-pays immediately (well-funded)
 *   3. unfunded-winner     -> closes, stays AWAITING_PAYMENT (insufficient balance)
 *   4. default-then-second -> winner (defaulter) is underfunded; second bidder can pay later
 *   5. cheap               -> price ($20) below the $50 deposit; tests the refund path
 *   6. unfunded-retry       -> separate underfunded winner, for the auto-retry scenario
 *   7. default-then-lapse   -> both the winner and the second bidder are underfunded/won't pay
 *
 * Idempotent: cleans up its own prior rows first. Dev DB only.
 * Prints a JSON blob of ids/emails to stdout (last line) for the test runner.
 */
const PASSWORD = 'Test1234!';

const USERS = {
  seller: { email: 'seller.orders@test.local', roles: ['SELLER'] },
  winner: { email: 'winner.orders@test.local', roles: ['BUYER'] },
  poor: { email: 'poor.orders@test.local', roles: ['BUYER'] },
  defaulter: { email: 'defaulter.orders@test.local', roles: ['BUYER'] },
  second: { email: 'second.orders@test.local', roles: ['BUYER'] },
  cheapWinner: { email: 'cheapwinner.orders@test.local', roles: ['BUYER'] },
  retryPoor: { email: 'retrypoor.orders@test.local', roles: ['BUYER'] },
  defaulter2: { email: 'defaulter2.orders@test.local', roles: ['BUYER'] },
  second2: { email: 'second2.orders@test.local', roles: ['BUYER'] },
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
  const ids: Record<string, string> = {};
  for (const [key, u] of Object.entries(USERS)) {
    ids[key] = await upsertUser(client, u.email, u.roles, hashed);
  }
  const allUserIds = Object.values(ids);

  // 2) cleanup prior test rows (scoped to this seller's objects + these users' wallets)
  await client.query(
    `DELETE FROM "WalletTransaction" WHERE "walletId" IN (SELECT id FROM "Wallet" WHERE "userId" = ANY($1));`,
    [allUserIds],
  );
  await client.query(`DELETE FROM "Wallet" WHERE "userId" = ANY($1);`, [allUserIds]);
  await client.query(
    `DELETE FROM "Order" WHERE "auctionId" IN (
       SELECT id FROM "Auction" WHERE "objectId" IN (SELECT id FROM "Object" WHERE "ownerId" = $1)
     );`,
    [ids.seller],
  );
  await client.query(
    `DELETE FROM "Bid" WHERE "auctionId" IN (
       SELECT id FROM "Auction" WHERE "objectId" IN (SELECT id FROM "Object" WHERE "ownerId" = $1)
     );`,
    [ids.seller],
  );
  await client.query(
    `DELETE FROM "AuctionDeposit" WHERE "auctionId" IN (
       SELECT id FROM "Auction" WHERE "objectId" IN (SELECT id FROM "Object" WHERE "ownerId" = $1)
     );`,
    [ids.seller],
  );
  await client.query(
    `DELETE FROM "Auction" WHERE "objectId" IN (SELECT id FROM "Object" WHERE "ownerId" = $1);`,
    [ids.seller],
  );
  await client.query(`DELETE FROM "Object" WHERE "ownerId" = $1;`, [ids.seller]);

  // 3) wallets — balance/lockedBalance already reflect a held $50 deposit where applicable
  const mkWallet = (userId: string, balance: number, locked: number) =>
    client.query(
      `INSERT INTO "Wallet" ("id","userId","balance","lockedBalance","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,now(),now());`,
      [randomUUID(), userId, balance, locked],
    );
  await mkWallet(ids.winner, 450, 50); // $500 total, $50 held for funded-winner
  await mkWallet(ids.poor, 0, 50); // $50 total, all held — insufficient for the $150 due
  await mkWallet(ids.defaulter, 0, 50); // underfunded winner in default-then-second
  await mkWallet(ids.second, 500, 0); // funded second bidder — no deposit (released on outbid)
  await mkWallet(ids.cheapWinner, 450, 50); // $500 total, $50 held for the cheap auction
  await mkWallet(ids.retryPoor, 0, 50); // underfunded, dedicated to the auto-retry scenario
  await mkWallet(ids.defaulter2, 0, 50); // underfunded winner in default-then-lapse
  await mkWallet(ids.second2, 0, 0); // no funds — will let their second-chance offer lapse too

  // 4) auctions — helper to create Object + Auction (LIVE, endTime already in the past)
  const DAY_MS = 24 * 60 * 60 * 1000;
  async function mkAuction(opts: {
    title: string;
    startingPrice: number;
    currentPrice: number;
    currentWinnerId: string | null;
  }): Promise<string> {
    const objId = randomUUID();
    await client.query(
      `INSERT INTO "Object" ("id","ownerId","category","title","mainImage","status","createdAt","updatedAt")
       VALUES ($1,$2,'ART',$3,'https://ik.imagekit.io/test/orders.jpg','IN_AUCTION',now(),now());`,
      [objId, ids.seller, opts.title],
    );
    const auctionId = randomUUID();
    await client.query(
      `INSERT INTO "Auction"
         ("id","objectId","startingPrice","minBidIncrement","currentPrice","currentWinnerId","durationDays",
          "startTime","endTime","antiSnipeSeconds","extendBySeconds","viewsCount","status","createdAt","updatedAt")
       VALUES ($1,$2,$3,50,$4,$5,1,
               now() - interval '2 days', now() - interval '1 hour',
               60,60,0,'LIVE',now(),now());`,
      [auctionId, objId, opts.startingPrice, opts.currentPrice, opts.currentWinnerId],
    );
    return auctionId;
  }

  const mkBid = (auctionId: string, bidderId: string, amount: number) =>
    client.query(
      `INSERT INTO "Bid" ("id","auctionId","bidderId","amount","createdAt") VALUES ($1,$2,$3,$4,now());`,
      [randomUUID(), auctionId, bidderId, amount],
    );
  const mkDeposit = (auctionId: string, userId: string) =>
    client.query(
      `INSERT INTO "AuctionDeposit" ("id","auctionId","userId","amount","status","createdAt","updatedAt")
       VALUES ($1,$2,$3,50,'HELD',now(),now());`,
      [randomUUID(), auctionId, userId],
    );

  const noBids = await mkAuction({
    title: '[TEST-ORD] no-bids',
    startingPrice: 100,
    currentPrice: 0,
    currentWinnerId: null,
  });

  const fundedWinner = await mkAuction({
    title: '[TEST-ORD] funded-winner',
    startingPrice: 100,
    currentPrice: 200,
    currentWinnerId: ids.winner,
  });
  await mkBid(fundedWinner, ids.winner, 200);
  await mkDeposit(fundedWinner, ids.winner);

  const unfundedWinner = await mkAuction({
    title: '[TEST-ORD] unfunded-winner',
    startingPrice: 100,
    currentPrice: 200,
    currentWinnerId: ids.poor,
  });
  await mkBid(unfundedWinner, ids.poor, 200);
  await mkDeposit(unfundedWinner, ids.poor);

  const defaultThenSecond = await mkAuction({
    title: '[TEST-ORD] default-then-second',
    startingPrice: 100,
    currentPrice: 200,
    currentWinnerId: ids.defaulter,
  });
  await mkBid(defaultThenSecond, ids.defaulter, 200);
  await mkBid(defaultThenSecond, ids.second, 150);
  await mkDeposit(defaultThenSecond, ids.defaulter);

  const cheap = await mkAuction({
    title: '[TEST-ORD] cheap',
    startingPrice: 20,
    currentPrice: 20,
    currentWinnerId: ids.cheapWinner,
  });
  await mkBid(cheap, ids.cheapWinner, 20);
  await mkDeposit(cheap, ids.cheapWinner);

  const unfundedRetry = await mkAuction({
    title: '[TEST-ORD] unfunded-retry',
    startingPrice: 100,
    currentPrice: 200,
    currentWinnerId: ids.retryPoor,
  });
  await mkBid(unfundedRetry, ids.retryPoor, 200);
  await mkDeposit(unfundedRetry, ids.retryPoor);

  const defaultThenLapse = await mkAuction({
    title: '[TEST-ORD] default-then-lapse',
    startingPrice: 100,
    currentPrice: 200,
    currentWinnerId: ids.defaulter2,
  });
  await mkBid(defaultThenLapse, ids.defaulter2, 200);
  await mkBid(defaultThenLapse, ids.second2, 150);
  await mkDeposit(defaultThenLapse, ids.defaulter2);

  await client.end();

  const out = {
    password: PASSWORD,
    emails: Object.fromEntries(Object.entries(USERS).map(([k, u]) => [k, u.email])),
    ids,
    auctions: {
      noBids,
      fundedWinner,
      unfundedWinner,
      defaultThenSecond,
      cheap,
      unfundedRetry,
      defaultThenLapse,
    },
  };
  console.log('SEED_RESULT ' + JSON.stringify(out));
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
