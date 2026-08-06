// Live HTTP test matrix for the bids module. Run with: node scripts/test-bids.mjs
// Requires the server running on :3000 and seed-bids-test.ts already run.
const BASE = process.env.BASE_URL || 'http://localhost:3000';

// From the latest seed-bids-test run (or pass SEED_JSON env var to override):
const seed = process.env.SEED_JSON ? JSON.parse(process.env.SEED_JSON) : null;
const IDS = {
  liveAuctionId: seed?.liveAuctionId ?? '57d6a128-d1f7-44f6-b613-d15ea6f5695b',
  draftAuctionId: seed?.draftAuctionId ?? '958918b6-e7b2-4dee-9e36-ac0575aa1a6f',
  randomId: '00000000-0000-0000-0000-000000000000',
};
const USERS = {
  seller: 'seller.bids@test.local',
  buyerA: 'buyerA.bids@test.local',
  buyerB: 'buyerB.bids@test.local',
  buyerC: 'buyerC.bids@test.local',
};
const PASSWORD = 'Test1234!';

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

async function login(email) {
  const { status, json } = await req('POST', '/auth/login', { body: { email, password: PASSWORD } });
  if (status !== 200 && status !== 201) throw new Error(`login ${email} failed: ${status} ${JSON.stringify(json)}`);
  return json.token;
}

async function wallet(token) {
  const { json } = await req('GET', '/wallet', { token });
  return json; // { balance, lockedBalance, currency }
}

async function main() {
  const t = {
    seller: await login(USERS.seller),
    A: await login(USERS.buyerA),
    B: await login(USERS.buyerB),
    C: await login(USERS.buyerC),
  };
  console.log('logged in seller/A/B/C\n');

  const live = IDS.liveAuctionId;
  const P = '/auctions/' + live + '/bids';

  // ---- POST /auctions/:id/bids — non-mutating rejections first ----
  let r;
  r = await req('POST', P, { body: { amount: 100 } }); // no token
  check('POST bid', 'guest no token -> 401', r.status === 401, `got ${r.status}`);

  r = await req('POST', P, { token: t.A, body: { amount: -5 } });
  check('POST bid', 'negative amount -> 400 (Zod)', r.status === 400, `got ${r.status}`);

  r = await req('POST', P, { token: t.A, body: { amount: 10.999 } });
  check('POST bid', '3-decimals amount -> 400 (Zod)', r.status === 400, `got ${r.status}`);

  r = await req('POST', P, { token: t.A, body: { amount: 50 } });
  check('POST bid', 'first bid below startingPrice(100) -> 400', r.status === 400,
    `got ${r.status}: ${r.json?.message}`);

  r = await req('POST', P, { token: t.seller, body: { amount: 100 } });
  check('POST bid', 'owner bids own auction -> 403', r.status === 403, `got ${r.status}: ${r.json?.message}`);

  r = await req('POST', P, { token: t.C, body: { amount: 100 } });
  check('POST bid', 'buyerC balance $20 < $50 deposit -> 400 insufficient', r.status === 400,
    `got ${r.status}: ${r.json?.message}`);

  r = await req('POST', '/auctions/' + IDS.draftAuctionId + '/bids', { token: t.B, body: { amount: 100 } });
  check('POST bid', 'bid on DRAFT auction -> 400 not live', r.status === 400, `got ${r.status}: ${r.json?.message}`);

  r = await req('POST', '/auctions/' + IDS.randomId + '/bids', { token: t.B, body: { amount: 100 } });
  check('POST bid', 'bid on random id -> 404', r.status === 404, `got ${r.status}`);

  // ---- Happy path sequence ----
  r = await req('POST', P, { token: t.A, body: { amount: 100 } });
  const okFirst = r.status === 201 && r.json?.depositHeld === true && r.json?.currentPrice === '100.00';
  check('POST bid', 'A first bid $100 -> 201 depositHeld currentPrice 100', okFirst,
    `got ${r.status}: ${JSON.stringify(r.json)}`);
  let w = await wallet(t.A);
  check('wallet', 'A balance 50 / locked 50 after hold', w?.balance === '50.00' && w?.lockedBalance === '50.00',
    JSON.stringify(w));

  r = await req('POST', P, { token: t.A, body: { amount: 200 } });
  check('POST bid', 'A (current winner) re-bids -> 400 already highest', r.status === 400,
    `got ${r.status}: ${r.json?.message}`);

  r = await req('POST', P, { token: t.B, body: { amount: 150 } });
  check('POST bid', 'B outbids $150 -> 201', r.status === 201, `got ${r.status}: ${JSON.stringify(r.json)}`);
  const wa = await wallet(t.A), wb = await wallet(t.B);
  check('wallet', 'A released (100/0) after outbid', wa?.balance === '100.00' && wa?.lockedBalance === '0.00', JSON.stringify(wa));
  check('wallet', 'B held (50/50)', wb?.balance === '50.00' && wb?.lockedBalance === '50.00', JSON.stringify(wb));

  r = await req('POST', P, { token: t.A, body: { amount: 200 } });
  check('POST bid', 'A retakes lead $200 -> 201', r.status === 201, `got ${r.status}: ${JSON.stringify(r.json)}`);
  const wa2 = await wallet(t.A), wb2 = await wallet(t.B);
  check('wallet', 'A re-held (50/50), no duplicate deposit', wa2?.balance === '50.00' && wa2?.lockedBalance === '50.00', JSON.stringify(wa2));
  check('wallet', 'B released again (100/0)', wb2?.balance === '100.00' && wb2?.lockedBalance === '0.00', JSON.stringify(wb2));

  // currentPrice 200 sits in the $10 tier, so the floor is 210 — NOT the stale 50
  // still stored on this seeded row (the tier table is the only source of truth)
  r = await req('POST', P, { token: t.B, body: { amount: 200 } });
  check('POST bid', 'B below floor (needs 210) -> 400', r.status === 400, `got ${r.status}: ${r.json?.message}`);

  r = await req('POST', P, { token: t.B, body: { amount: 205 } });
  check('POST bid', 'floor comes from the price tier, not the stored increment -> "Minimum bid is $210.00"',
    r.status === 400 && /210\.00/.test(r.json?.message ?? ''), `got ${r.status}: ${r.json?.message}`);

  // ---- GET /auctions/:id/bids (public) ----
  r = await req('GET', P); // no token, public
  const items = r.json?.items;
  const orderOk = Array.isArray(items) && items.length === 3 &&
    items[0].amount === '200.00' && items[1].amount === '150.00' && items[2].amount === '100.00';
  const namesOk = Array.isArray(items) && items.every((i) => typeof i.bidderName === 'string' && i.bidderName.length > 0);
  check('GET auction bids', 'public list, 3 bids highest-first', r.status === 200 && orderOk,
    `got ${r.status}, amounts ${items?.map((i) => i.amount).join(',')}`);
  check('GET auction bids', 'full bidder names present', namesOk, JSON.stringify(items?.map((i) => i.bidderName)));

  r = await req('GET', '/auctions/' + IDS.draftAuctionId + '/bids');
  check('GET auction bids', 'DRAFT auction history -> 404', r.status === 404, `got ${r.status}`);

  r = await req('GET', '/auctions/' + IDS.randomId + '/bids');
  check('GET auction bids', 'random id history -> 404', r.status === 404, `got ${r.status}`);

  // ---- GET /bids/mine ----
  r = await req('GET', '/bids/mine'); // no token
  check('GET bids/mine', 'guest -> 401', r.status === 401, `got ${r.status}`);

  r = await req('GET', '/bids/mine', { token: t.A });
  const mine = r.json?.items;
  const mineOk = Array.isArray(mine) && mine.length === 2 && mine.every((m) => m.auctionId === live);
  const winningOk = Array.isArray(mine) && mine.some((m) => m.isWinning === true);
  check('GET bids/mine', 'A sees own 2 bids', r.status === 200 && mineOk, `got ${r.status}, count ${mine?.length}`);
  check('GET bids/mine', 'A isWinning true (current leader)', winningOk, JSON.stringify(mine?.map((m) => ({ amt: m.myAmount, win: m.isWinning }))));

  // ---- summary ----
  const pass = results.filter((x) => x.ok).length;
  console.log(`\n=== ${pass}/${results.length} passed ===`);
  if (pass !== results.length) {
    console.log('FAILURES:');
    results.filter((x) => !x.ok).forEach((x) => console.log(`  ❌ [${x.endpoint}] ${x.name} — ${x.detail}`));
    process.exit(1);
  }
}
main().catch((e) => { console.error('runner error:', e); process.exit(2); });
