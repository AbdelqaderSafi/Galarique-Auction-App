import 'dotenv/config';
import { Client } from 'pg';

/**
 * Wipes every table (except _prisma_migrations) in whatever DATABASE_URL points to.
 * Intended ONLY for the isolated galleryq_system_test database — run before a full
 * System Testing pass so every run starts from a clean, known state.
 *
 * Safety guard: refuses to run unless the connection string clearly targets a
 * "test" database, to make it impossible to accidentally wipe dev/prod data.
 */
async function main() {
  const url = process.env.DATABASE_URL ?? '';
  if (!/test/i.test(url)) {
    throw new Error(
      `Refusing to reset a database whose URL doesn't look like a test DB: ${url}`,
    );
  }

  const client = new Client({ connectionString: url });
  await client.connect();

  const { rows } = await client.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename != '_prisma_migrations'`,
  );

  if (rows.length > 0) {
    const names = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
    await client.query(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE;`);
  }

  await client.end();
  console.log(`System-test database reset (${rows.length} tables truncated).`);
}

main().catch((err) => {
  console.error('Reset failed:', err);
  process.exit(1);
});
