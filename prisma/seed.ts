import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import * as argon from 'argon2';

/**
 * Seeds the platform admin from environment variables.
 * Idempotent: re-running updates the admin's password & role to match .env.
 *
 *   ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_FULLNAME (optional)
 *
 * Run with: npm run seed
 */
async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const fullName = process.env.ADMIN_FULLNAME ?? 'Platform Admin';

  if (!email || !password) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env');
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const hashedPassword = await argon.hash(password);

  const result = await client.query(
    `INSERT INTO "User"
       ("id", "fullName", "email", "password", "provider", "roles", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, 'LOCAL', ARRAY['ADMIN']::"Role"[], now(), now())
     ON CONFLICT ("email") DO UPDATE
       SET "password" = EXCLUDED."password",
           "roles" = ARRAY['ADMIN']::"Role"[],
           "updatedAt" = now()
     RETURNING "email", "roles";`,
    [randomUUID(), fullName, email, hashedPassword],
  );

  const admin = result.rows[0];
  console.log(`✓ Admin ready: ${admin.email} (roles: ${admin.roles})`);
  await client.end();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
