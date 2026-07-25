// Master runner for System Testing: resets the isolated galleryq_system_test
// database, seeds the admin, then runs every seed+test pair against a real,
// already-running server (see .env.system-test) and prints one pass/fail table.
//
// Run with: node scripts/run-system-tests.mjs
// Prerequisite: the dev server must already be running against .env.system-test
// (see the "System Testing" section of docs/PROJECT-CONTEXT.md / the final test report for the
// exact command), reachable at BASE_URL (default http://localhost:3100).
import { spawnSync } from 'child_process';
import { config as loadDotenv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

loadDotenv({ path: path.join(ROOT, '.env.system-test') });

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const SERVER_LOG = process.env.SERVER_LOG || path.join(ROOT, 'system-test-server.log');

const steps = []; // { name, ok, detail }

function run(cmd, extraEnv = {}) {
  const result = spawnSync(cmd, {
    shell: true,
    cwd: ROOT,
    env: { ...process.env, BASE_URL, SERVER_LOG, ...extraEnv },
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
  });
  return result;
}

function seedResultOf(stdout) {
  const line = (stdout || '').split('\n').find((l) => l.startsWith('SEED_RESULT '));
  if (!line) return null;
  try {
    return JSON.parse(line.slice('SEED_RESULT '.length));
  } catch {
    return null;
  }
}

function runSeed(label, scriptPath) {
  console.log(`\n--- seeding: ${label} ---`);
  const r = run(`npx ts-node --transpile-only ${scriptPath}`);
  console.log(r.stdout);
  if (r.stderr) console.error(r.stderr);
  const seed = seedResultOf(r.stdout);
  const ok = r.status === 0 && !!seed;
  steps.push({ name: `seed: ${label}`, ok, detail: ok ? 'ok' : `exit ${r.status}` });
  return seed;
}

function runTest(label, scriptPath, extraEnv = {}) {
  console.log(`\n--- running: ${label} ---`);
  const r = run(`node ${scriptPath}`, extraEnv);
  console.log(r.stdout);
  if (r.stderr) console.error(r.stderr);
  const summaryLine = (r.stdout || '').split('\n').find((l) => l.includes('==='));
  steps.push({ name: label, ok: r.status === 0, detail: r.status === 0 ? (summaryLine?.trim() ?? 'ok') : `exit ${r.status}` });
}

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${BASE_URL}/categories`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function main() {
  console.log(`Waiting for server at ${BASE_URL} ...`);
  const up = await waitForServer();
  if (!up) {
    console.error(`Server not reachable at ${BASE_URL} after 40s. Start it against .env.system-test first.`);
    process.exit(2);
  }
  console.log('Server is up.\n');

  console.log('--- resetting galleryq_system_test database ---');
  const resetR = run('npx ts-node --transpile-only scripts/reset-system-test-db.ts');
  console.log(resetR.stdout);
  if (resetR.stderr) console.error(resetR.stderr);
  steps.push({ name: 'reset database', ok: resetR.status === 0, detail: resetR.status === 0 ? 'ok' : `exit ${resetR.status}` });

  console.log('--- seeding admin (npm run seed) ---');
  const adminR = run('npx ts-node --transpile-only prisma/seed.ts');
  console.log(adminR.stdout);
  if (adminR.stderr) console.error(adminR.stderr);
  steps.push({ name: 'seed admin', ok: adminR.status === 0, detail: adminR.status === 0 ? 'ok' : `exit ${adminR.status}` });

  // ---- bids + anti-snipe ----
  const bidsSeed = runSeed('bids', 'scripts/seed-bids-test.ts');
  if (bidsSeed) {
    runTest('test-bids.mjs', 'scripts/test-bids.mjs', { SEED_JSON: JSON.stringify(bidsSeed) });
    runTest('test-antisnipe.mjs', 'scripts/test-antisnipe.mjs');
  }

  // ---- favorites/follows ----
  const favSeed = runSeed('favorites', 'scripts/seed-favorites-test.ts');
  if (favSeed) {
    runTest('test-favorites.mjs', 'scripts/test-favorites.mjs', { SEED_JSON: JSON.stringify(favSeed) });
  }

  // ---- orders/settlement (needs the admin seeded above for POST /scheduler/run) ----
  const ordersSeed = runSeed('orders', 'scripts/seed-orders-test.ts');
  if (ordersSeed) {
    runTest('test-orders.mjs', 'scripts/test-orders.mjs', { SEED_JSON: JSON.stringify(ordersSeed) });
  }

  // ---- realtime SSE ----
  const rtSeed = runSeed('realtime', 'scripts/seed-realtime-test.ts');
  if (rtSeed) {
    runTest('test-realtime.mjs', 'scripts/test-realtime.mjs', {
      AUCTION_ID: rtSeed.auctionId,
      TOKEN_A: rtSeed.tokenA,
      TOKEN_B: rtSeed.tokenB,
      USER_B_ID: rtSeed.userBId,
      CLOSE_AUCTION_ID: rtSeed.closeAuctionId,
    });
  }

  // ---- comprehensive black-box system E2E (auth/auctions wizard/wallet/admin) ----
  runTest('test-system-e2e.mjs', 'scripts/test-system-e2e.mjs');

  // ---- final summary ----
  console.log('\n\n================ SYSTEM TESTING SUMMARY ================');
  for (const s of steps) {
    console.log(`${s.ok ? '✅' : '❌'} ${s.name} — ${s.detail}`);
  }
  const failed = steps.filter((s) => !s.ok);
  console.log(`\n${steps.length - failed.length}/${steps.length} steps passed.`);
  if (failed.length) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('runner error:', e);
  process.exit(2);
});
