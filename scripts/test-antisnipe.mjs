// Anti-snipe check: seed a LIVE auction ending in 40s, bid, assert endTime extended by ~60s.
import 'dotenv/config';
import { randomUUID } from 'crypto';
import pg from 'pg';
const { Client } = pg;
const BASE = process.env.BASE_URL || 'http://localhost:3000';

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // seller from the main seed
  const seller = await client.query(`SELECT id FROM "User" WHERE email='seller.bids@test.local'`);
  const sellerId = seller.rows[0].id;

  const objId = randomUUID();
  await client.query(
    `INSERT INTO "Object" ("id","ownerId","category","title","mainImage","status","createdAt","updatedAt")
     VALUES ($1,$2,'ART','[TEST] Anti-snipe','https://ik.imagekit.io/test/as.jpg','IN_AUCTION',now(),now());`,
    [objId, sellerId],
  );
  const auctionId = randomUUID();
  await client.query(
    `INSERT INTO "Auction"
       ("id","objectId","startingPrice","minBidIncrement","currentPrice","durationDays",
        "startTime","endTime","antiSnipeSeconds","extendBySeconds","viewsCount","status","createdAt","updatedAt")
     VALUES ($1,$2,100,50,0,1, now(), now() + interval '40 seconds', 60,60,0,'LIVE',now(),now());`,
    [auctionId, objId],
  );
  // read endTime BEFORE the bid (same pg client => tz-consistent)
  const before = await client.query(`SELECT "endTime" FROM "Auction" WHERE id=$1`, [auctionId]);
  const endBefore = new Date(before.rows[0].endTime).getTime();

  // login buyerB (has $100 after the main test released it)
  const lr = await fetch(BASE + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'buyerB.bids@test.local', password: 'Test1234!' }),
  });
  const token = (await lr.json()).token;

  // bid within the anti-snipe window
  const br = await fetch(BASE + '/auctions/' + auctionId + '/bids', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ amount: 100 }),
  });
  const bidStatus = br.status;

  // read endTime AFTER the bid (same pg client)
  const after = await client.query(`SELECT "endTime" FROM "Auction" WHERE id=$1`, [auctionId]);
  const endAfter = new Date(after.rows[0].endTime).getTime();
  await client.end();

  const extendedBySec = Math.round((endAfter - endBefore) / 1000);
  const ok = bidStatus === 201 && extendedBySec >= 55 && extendedBySec <= 65;
  console.log(`${ok ? '✅' : '❌'} anti-snipe: bid ${bidStatus}, endTime extended by ${extendedBySec}s (expected 60)`);
  console.log(`   endTime before bid: ${new Date(endBefore).toISOString()}`);
  console.log(`   endTime after  bid: ${new Date(endAfter).toISOString()}`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
