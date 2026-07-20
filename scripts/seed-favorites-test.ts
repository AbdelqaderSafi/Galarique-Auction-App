import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import * as argon from 'argon2';

/**
 * Seeds test data for exercising the favorites/follows module over real HTTP.
 * Creates: a seller (with SellerProfile), a plain buyer (no SellerProfile — for
 * the "follow a non-seller" 404 case), a second buyer (the actor running the tests),
 * one LIVE auction (favoritable), and one DRAFT auction (non-public — for the
 * "favorite a non-public auction" 404 case). Favorites are auctions-only.
 * Idempotent: cleans up its own prior rows first. Dev DB only.
 */
const PASSWORD = 'Test1234!';

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

  const sellerEmail = 'seller.favs@test.local';
  const plainEmail = 'plain.favs@test.local';
  const actorEmail = 'actor.favs@test.local';

  const sellerId = await upsertUser(client, sellerEmail, ['SELLER'], hashed);
  const plainId = await upsertUser(client, plainEmail, ['BUYER'], hashed);
  const actorId = await upsertUser(client, actorEmail, ['BUYER'], hashed);

  // cleanup prior test rows
  await client.query(
    `DELETE FROM "FavoriteObject" WHERE "userId" = ANY($1);`,
    [[sellerId, plainId, actorId]],
  );
  await client.query(
    `DELETE FROM "FavoriteAuction" WHERE "userId" = ANY($1);`,
    [[sellerId, plainId, actorId]],
  );
  await client.query(
    `DELETE FROM "Follow" WHERE "followerId" = ANY($1) OR "sellerId" = ANY($1);`,
    [[sellerId, plainId, actorId]],
  );
  await client.query(
    `DELETE FROM "Auction" WHERE "objectId" IN (SELECT id FROM "Object" WHERE "ownerId" = $1);`,
    [sellerId],
  );
  await client.query(`DELETE FROM "Object" WHERE "ownerId" = $1;`, [sellerId]);
  await client.query(
    `DELETE FROM "SellerProfile" WHERE "userId" = $1;`,
    [sellerId],
  );

  // seller profile (makes sellerId a valid follow target)
  await client.query(
    `INSERT INTO "SellerProfile" ("id","userId","phoneNumber","phoneVerifiedAt","createdAt","updatedAt")
     VALUES ($1,$2,$3,now(),now(),now());`,
    [randomUUID(), sellerId, '+970599' + Math.floor(100000 + Math.random() * 899999)],
  );

  // LIVE auction (public — favoritable)
  const liveObjectId = randomUUID();
  await client.query(
    `INSERT INTO "Object" ("id","ownerId","category","title","mainImage","status","createdAt","updatedAt")
     VALUES ($1,$2,'ART','[TEST] Live Favoritable Auction','https://ik.imagekit.io/test/fav-live.jpg','IN_AUCTION',now(),now());`,
    [liveObjectId, sellerId],
  );
  const liveAuctionId = randomUUID();
  await client.query(
    `INSERT INTO "Auction"
       ("id","objectId","startingPrice","minBidIncrement","currentPrice","durationDays",
        "startTime","endTime","antiSnipeSeconds","extendBySeconds","viewsCount","status","createdAt","updatedAt")
     VALUES ($1,$2,100,50,0,1, now(), now() + interval '1 day', 60,60,0,'LIVE',now(),now());`,
    [liveAuctionId, liveObjectId],
  );

  // DRAFT auction (non-public — 404 on favorite)
  const draftObjectId = randomUUID();
  await client.query(
    `INSERT INTO "Object" ("id","ownerId","category","title","mainImage","status","createdAt","updatedAt")
     VALUES ($1,$2,'ART','[TEST] Draft Auction','https://ik.imagekit.io/test/fav-draft.jpg','DRAFT',now(),now());`,
    [draftObjectId, sellerId],
  );
  const draftAuctionId = randomUUID();
  await client.query(
    `INSERT INTO "Auction"
       ("id","objectId","startingPrice","minBidIncrement","currentPrice","durationDays",
        "antiSnipeSeconds","extendBySeconds","viewsCount","status","createdAt","updatedAt")
     VALUES ($1,$2,100,50,0,1,60,60,0,'DRAFT',now(),now());`,
    [draftAuctionId, draftObjectId],
  );

  await client.end();

  const out = {
    password: PASSWORD,
    emails: { seller: sellerEmail, plain: plainEmail, actor: actorEmail },
    sellerId,
    plainId,
    actorId,
    liveAuctionId,
    draftAuctionId,
  };
  console.log('SEED_RESULT ' + JSON.stringify(out));
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
