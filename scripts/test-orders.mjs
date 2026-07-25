// Live HTTP test matrix for the scheduler + orders modules. Run with: node scripts/test-orders.mjs
// Requires the server running on :3000, seed-orders-test.ts already run, and `npm run seed` run once.
import 'dotenv/config';
import pg from 'pg';
const { Client } = pg;

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const PASSWORD = 'Test1234!';

// From the latest seed-orders-test run (or pass SEED_JSON env var to override):
const seed = process.env.SEED_JSON ? JSON.parse(process.env.SEED_JSON) : null;
const IDS = {
  seller: seed?.ids?.seller ?? 'd931b10c-e737-4080-96f4-b7e71cee8ef9',
  winner: seed?.ids?.winner ?? '8500d637-d456-4b57-a623-ab9f67428b1d',
  poor: seed?.ids?.poor ?? '3e6c6858-d288-424b-a6c6-667c1d34ed17',
  defaulter: seed?.ids?.defaulter ?? '38a6cbd2-4b00-461a-ac2f-d9e8e357acf7',
  second: seed?.ids?.second ?? 'e111e3b9-c97e-4779-932f-3c0822389bc5',
  cheapWinner: seed?.ids?.cheapWinner ?? 'ee640992-3e14-4e9d-860e-9982e22f60c4',
  retryPoor: seed?.ids?.retryPoor ?? '8369d32c-7878-4546-8941-b30c91ef62b4',
  defaulter2: seed?.ids?.defaulter2 ?? '15f5064d-60ca-49eb-b489-3df82fab5f16',
  second2: seed?.ids?.second2 ?? '0ec02e2e-913a-4c14-afb6-6af5d8902beb',
};
const AUCTIONS = {
  noBids: seed?.auctions?.noBids ?? '967838d2-1896-4d92-bc7b-3fd8f3a045a7',
  fundedWinner: seed?.auctions?.fundedWinner ?? 'b0f1dedf-e8a7-42a2-99a9-6c303d176236',
  unfundedWinner: seed?.auctions?.unfundedWinner ?? '6e565875-48ee-460c-ab80-f707a08268b6',
  defaultThenSecond: seed?.auctions?.defaultThenSecond ?? '2c04efe7-17fa-4535-862e-492a5c895aa5',
  cheap: seed?.auctions?.cheap ?? '94923a71-d213-4080-8750-faf5c283deac',
  unfundedRetry: seed?.auctions?.unfundedRetry ?? 'e120a2b3-2b10-46f9-ab2d-78af59b222d6',
  defaultThenLapse: seed?.auctions?.defaultThenLapse ?? 'b20d82c6-fa41-4958-a1e2-514455fc284a',
};
const EMAILS = {
  seller: 'seller.orders@test.local',
  winner: 'winner.orders@test.local',
  poor: 'poor.orders@test.local',
  defaulter: 'defaulter.orders@test.local',
  second: 'second.orders@test.local',
  cheapWinner: 'cheapwinner.orders@test.local',
  retryPoor: 'retrypoor.orders@test.local',
  defaulter2: 'defaulter2.orders@test.local',
  second2: 'second2.orders@test.local',
};

const results = [];
function check(endpoint, name, ok, detail) {
  results.push({ endpoint, name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} [${endpoint}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function req(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

async function login(email, password = PASSWORD) {
  const { status, json } = await req('POST', '/auth/login', { body: { email, password } });
  if (status !== 200 && status !== 201) throw new Error(`login ${email} failed: ${status} ${JSON.stringify(json)}`);
  return json.token;
}

async function wallet(token) {
  const { json } = await req('GET', '/wallet', { token });
  return json;
}

async function runTick(adminToken) {
  const { status, json } = await req('POST', '/scheduler/run', { token: adminToken });
  return { status, ...json };
}

// find one order id by auctionId/buyerEmail/offerRank/status among a user's orders (mine or sales)
function findOrder(items, matcher) {
  return items.find(matcher);
}

async function main() {
  const pgClient = new Client({ connectionString: process.env.DATABASE_URL });
  await pgClient.connect();

  const admin = await login(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);
  const t = {};
  for (const [key, email] of Object.entries(EMAILS)) {
    t[key] = await login(email);
  }
  console.log('logged in admin + all test users\n');

  // ===== Tick 1: close all 7 due auctions =====
  // NOTE: the real @Cron(EVERY_MINUTE) is also running in the background on this
  // live server, so it may beat this manual tick to the due items (proving the
  // catch-up design is safe under real overlapping execution). We don't assert an
  // exact count here — only that the endpoint responds with the right shape — and
  // instead verify the actual settled STATE in the checks below, which is authoritative
  // regardless of whether this call or a background tick did the work.
  let tick = await runTick(admin);
  check('POST /scheduler/run', 'tick 1 (admin) -> 200', tick.status === 200, JSON.stringify(tick));
  check('POST /scheduler/run', 'tick 1 response has the right shape', typeof tick.closed === 'number' && typeof tick.expired === 'number' && typeof tick.retriedPaid === 'number', JSON.stringify(tick));

  // ---- Case 1: no-bids -> UNSOLD ----
  let r = await req('GET', `/auctions/${AUCTIONS.noBids}`);
  check('GET /auctions/:id', 'no-bids auction -> UNSOLD', r.json?.status === 'UNSOLD', `got ${r.json?.status}`);

  // ---- Case 2: funded-winner -> auto-paid ----
  r = await req('GET', `/auctions/${AUCTIONS.fundedWinner}`);
  check('GET /auctions/:id', 'funded-winner auction -> SOLD', r.json?.status === 'SOLD', `got ${r.json?.status}`);
  let w = await wallet(t.winner);
  check('wallet', 'winner balance 300 (450-150) after auto-pay', w?.balance === '300.00', JSON.stringify(w));
  check('wallet', 'winner lockedBalance 0 (deposit applied)', w?.lockedBalance === '0.00', JSON.stringify(w));
  r = await req('GET', '/wallet/transactions', { token: t.winner });
  const hasPurchase = r.json?.items?.some((x) => x.type === 'PURCHASE');
  check('GET /wallet/transactions', 'winner has a PURCHASE txn', hasPurchase, JSON.stringify(r.json?.items?.map((x) => x.type)));
  let sw = await wallet(t.seller);
  check('wallet', 'seller balance includes +200 from funded-winner sale', Number(sw.balance) >= 200, JSON.stringify(sw));
  r = await req('GET', '/wallet/transactions', { token: t.seller });
  const hasSale = r.json?.items?.some((x) => x.type === 'SALE');
  check('GET /wallet/transactions', 'seller has a SALE txn', hasSale, JSON.stringify(r.json?.items?.map((x) => x.type)));

  // find the unfunded-winner order (via seller sales) for case 3/4
  r = await req('GET', '/orders/sales?limit=100', { token: t.seller });
  let salesItems = r.json?.items ?? [];
  let unfundedOrder = findOrder(salesItems, (o) => o.auctionId === AUCTIONS.unfundedWinner);
  check('GET /orders/sales', 'unfunded-winner order found, AWAITING_PAYMENT', unfundedOrder?.status === 'AWAITING_PAYMENT', JSON.stringify(unfundedOrder));
  check('GET /orders/sales', 'unfunded-winner amountDue 150.00', unfundedOrder?.amountDue === '150.00', JSON.stringify(unfundedOrder));

  // ---- Case 3: pay with insufficient balance -> 400 ----
  r = await req('POST', `/orders/${unfundedOrder.id}/pay`, { token: t.poor });
  check('POST /orders/:id/pay', 'poor insufficient balance -> 400', r.status === 400, `got ${r.status}: ${r.json?.message}`);

  // ---- Case 4: top up poor directly, then pay explicitly ----
  await pgClient.query(`UPDATE "Wallet" SET balance = 200 WHERE "userId" = $1`, [IDS.poor]);
  r = await req('POST', `/orders/${unfundedOrder.id}/pay`, { token: t.poor });
  check('POST /orders/:id/pay', 'poor pays after top-up -> 200 COMPLETED', r.status === 200 && r.json?.status === 'COMPLETED', `got ${r.status}: ${JSON.stringify(r.json)}`);
  r = await req('GET', `/auctions/${AUCTIONS.unfundedWinner}`);
  check('GET /auctions/:id', 'unfunded-winner auction -> SOLD after pay', r.json?.status === 'SOLD', `got ${r.json?.status}`);

  // ---- Case 5: auto-retry (top up retryPoor, then tick pays automatically) ----
  await pgClient.query(`UPDATE "Wallet" SET balance = 200 WHERE "userId" = $1`, [IDS.retryPoor]);
  tick = await runTick(admin);
  check('POST /scheduler/run', 'tick 2 (after retryPoor top-up) -> 200', tick.status === 200, JSON.stringify(tick));
  // Same caveat as tick 1: the background cron may have already auto-retried this
  // order before this manual call ran. The auction-status check below is the
  // authoritative proof that retryWinnerPayments (this tick or an earlier
  // background one) paid it automatically — no /pay call was ever made for it.
  r = await req('GET', `/auctions/${AUCTIONS.unfundedRetry}`);
  check('GET /auctions/:id', 'unfunded-retry auction -> SOLD via auto-retry (no /pay call)', r.json?.status === 'SOLD', `got ${r.json?.status}`);

  // ===== Force default-then-second's and default-then-lapse's orders overdue =====
  r = await req('GET', '/orders/sales?limit=100', { token: t.seller });
  salesItems = r.json?.items ?? [];
  let defaulterOrder = findOrder(salesItems, (o) => o.auctionId === AUCTIONS.defaultThenSecond && o.offerRank === 1);
  let defaulter2Order = findOrder(salesItems, (o) => o.auctionId === AUCTIONS.defaultThenLapse && o.offerRank === 1);
  await pgClient.query(`UPDATE "Order" SET "paymentDeadline" = now() - interval '1 hour' WHERE id = $1`, [defaulterOrder.id]);
  await pgClient.query(`UPDATE "Order" SET "paymentDeadline" = now() - interval '1 hour' WHERE id = $1`, [defaulter2Order.id]);

  // ===== Tick 3: expire both -> forfeit + second-chance orders created =====
  tick = await runTick(admin);
  check('POST /scheduler/run', 'tick 3 (expire deadlines) -> 200', tick.status === 200, JSON.stringify(tick));
  check('POST /scheduler/run', 'tick 3 expired>=2', tick.expired >= 2, `got expired=${tick.expired}`);

  // ---- Case 6: default -> forfeit + second chance ----
  r = await req('GET', '/orders/sales?limit=100', { token: t.seller });
  salesItems = r.json?.items ?? [];
  const defaulterOrderAfter = findOrder(salesItems, (o) => o.id === defaulterOrder.id);
  check('GET /orders/sales', 'defaulter order -> DEFAULTED', defaulterOrderAfter?.status === 'DEFAULTED', JSON.stringify(defaulterOrderAfter));
  const secondChanceOrder = findOrder(salesItems, (o) => o.auctionId === AUCTIONS.defaultThenSecond && o.offerRank === 2);
  check('GET /orders/sales', 'second-chance order created (rank 2, amount 150.00, depositApplied 0.00)',
    secondChanceOrder?.amount === '150.00' && secondChanceOrder?.depositApplied === '0.00' && secondChanceOrder?.status === 'AWAITING_PAYMENT',
    JSON.stringify(secondChanceOrder));
  let dw = await wallet(t.defaulter);
  check('wallet', 'defaulter lockedBalance 0 after forfeiture', dw?.lockedBalance === '0.00', JSON.stringify(dw));
  r = await req('GET', '/wallet/transactions', { token: t.defaulter });
  const hasForfeit = r.json?.items?.some((x) => x.type === 'DEPOSIT_FORFEIT');
  check('GET /wallet/transactions', 'defaulter has a DEPOSIT_FORFEIT txn', hasForfeit, JSON.stringify(r.json?.items?.map((x) => x.type)));

  // ---- Case 9 (first half): the lapse auction also produced a second-chance order ----
  const lapseOrderAfter = findOrder(salesItems, (o) => o.id === defaulter2Order.id);
  check('GET /orders/sales', 'defaulter2 (lapse) order -> DEFAULTED', lapseOrderAfter?.status === 'DEFAULTED', JSON.stringify(lapseOrderAfter));
  const lapseSecondChance = findOrder(salesItems, (o) => o.auctionId === AUCTIONS.defaultThenLapse && o.offerRank === 2);
  check('GET /orders/sales', 'lapse second-chance order created (rank 2, second2)', lapseSecondChance?.status === 'AWAITING_PAYMENT', JSON.stringify(lapseSecondChance));

  // ---- Case 7: second chance is never auto-charged ----
  const secondBalanceBefore = (await wallet(t.second)).balance;
  tick = await runTick(admin);
  check('POST /scheduler/run', 'tick 4 -> 200', tick.status === 200, JSON.stringify(tick));
  r = await req('GET', '/orders/mine?limit=100', { token: t.second });
  const secondMine = findOrder(r.json?.items ?? [], (o) => o.id === secondChanceOrder.id);
  check('GET /orders/mine', 'second-chance order still AWAITING_PAYMENT after a tick', secondMine?.status === 'AWAITING_PAYMENT', JSON.stringify(secondMine));
  const secondBalanceAfter = (await wallet(t.second)).balance;
  check('wallet', "second's balance unchanged (never auto-charged)", secondBalanceBefore === secondBalanceAfter, `${secondBalanceBefore} -> ${secondBalanceAfter}`);

  // ---- Case 8: second chance pays explicitly ----
  r = await req('POST', `/orders/${secondChanceOrder.id}/pay`, { token: t.second });
  check('POST /orders/:id/pay', 'second pays second-chance offer -> 200 COMPLETED at $150', r.status === 200 && r.json?.amount === '150.00', `got ${r.status}: ${JSON.stringify(r.json)}`);
  r = await req('GET', `/auctions/${AUCTIONS.defaultThenSecond}`);
  check('GET /auctions/:id', 'default-then-second auction -> SOLD', r.json?.status === 'SOLD', `got ${r.json?.status}`);

  // ---- Case 9 (second half): force the lapse auction's rank-2 deadline into the past, tick, verify CANCELLED ----
  await pgClient.query(`UPDATE "Order" SET "paymentDeadline" = now() - interval '1 hour' WHERE id = $1`, [lapseSecondChance.id]);
  tick = await runTick(admin);
  check('POST /scheduler/run', 'tick 5 (expire the lapsed second-chance) -> 200', tick.status === 200, JSON.stringify(tick));
  r = await req('GET', '/orders/sales?limit=100', { token: t.seller });
  const lapseFinal = findOrder(r.json?.items ?? [], (o) => o.id === lapseSecondChance.id);
  check('GET /orders/sales', 'lapsed second-chance order -> CANCELLED', lapseFinal?.status === 'CANCELLED', JSON.stringify(lapseFinal));
  r = await req('GET', `/auctions/${AUCTIONS.defaultThenLapse}`);
  check('GET /auctions/:id', 'default-then-lapse auction -> UNSOLD', r.json?.status === 'UNSOLD', `got ${r.json?.status}`);

  // ---- Case 10: cheap ($20 < $50 deposit) ----
  r = await req('GET', '/orders/sales?limit=100', { token: t.seller });
  const cheapOrder = findOrder(r.json?.items ?? [], (o) => o.auctionId === AUCTIONS.cheap);
  check('GET /orders/sales', 'cheap order amountDue 0.00, COMPLETED', cheapOrder?.amountDue === '0.00' && cheapOrder?.status === 'COMPLETED', JSON.stringify(cheapOrder));
  let cw = await wallet(t.cheapWinner);
  check('wallet', 'cheapWinner net +30 refund (450 seed -> 480)', cw?.balance === '480.00', JSON.stringify(cw));
  r = await req('GET', '/wallet/transactions', { token: t.cheapWinner });
  const hasRefund = r.json?.items?.some((x) => x.type === 'REFUND');
  check('GET /wallet/transactions', 'cheapWinner has a REFUND txn', hasRefund, JSON.stringify(r.json?.items?.map((x) => x.type)));

  // ---- Case 11: guards ----
  r = await req('POST', `/orders/${cheapOrder.id}/pay`, { token: t.poor });
  check('POST /orders/:id/pay', "pay someone else's order -> 403", r.status === 403, `got ${r.status}`);
  r = await req('POST', `/orders/${cheapOrder.id}/pay`, { token: t.cheapWinner });
  check('POST /orders/:id/pay', 'pay an already-COMPLETED order -> 400', r.status === 400, `got ${r.status}: ${r.json?.message}`);
  r = await req('GET', `/orders/${cheapOrder.id}`, { token: t.poor });
  check('GET /orders/:id', 'third party reading an order -> 403', r.status === 403, `got ${r.status}`);
  r = await req('GET', '/orders/mine');
  check('GET /orders/mine', 'no token -> 401', r.status === 401, `got ${r.status}`);
  r = await req('POST', `/orders/${cheapOrder.id}/pay`);
  check('POST /orders/:id/pay', 'no token -> 401', r.status === 401, `got ${r.status}`);
  r = await req('POST', '/scheduler/run', { token: t.winner });
  check('POST /scheduler/run', 'non-admin -> 403', r.status === 403, `got ${r.status}`);

  // ---- Case 12: reads ----
  r = await req('GET', '/orders/mine?limit=100', { token: t.winner });
  const winnerHasFunded = (r.json?.items ?? []).some((o) => o.auctionId === AUCTIONS.fundedWinner);
  check('GET /orders/mine', 'winner sees their funded-winner order', winnerHasFunded, JSON.stringify(r.json?.items?.map((o) => o.auctionId)));
  r = await req('GET', '/orders/sales?limit=100', { token: t.seller });
  const salesCount = (r.json?.items ?? []).length;
  check('GET /orders/sales', 'seller sees all orders across auctions (>=8)', salesCount >= 8, `got ${salesCount} orders`);
  r = await req('GET', `/orders/${cheapOrder.id}`, { token: t.cheapWinner });
  check('GET /orders/:id', "counterpart is the seller with their email", r.json?.counterpart?.role === 'SELLER' && r.json?.counterpart?.email === EMAILS.seller, JSON.stringify(r.json?.counterpart));
  r = await req('GET', `/orders/${cheapOrder.id}`, { token: t.seller });
  check('GET /orders/:id', 'counterpart (as seller) is the buyer with their email', r.json?.counterpart?.role === 'BUYER' && r.json?.counterpart?.email === EMAILS.cheapWinner, JSON.stringify(r.json?.counterpart));

  await pgClient.end();

  const pass = results.filter((x) => x.ok).length;
  console.log(`\n=== ${pass}/${results.length} passed ===`);
  if (pass !== results.length) {
    console.log('FAILURES:');
    results.filter((x) => !x.ok).forEach((x) => console.log(`  ❌ [${x.endpoint}] ${x.name} — ${x.detail}`));
    process.exit(1);
  }
}
main().catch((e) => { console.error('runner error:', e); process.exit(2); });
