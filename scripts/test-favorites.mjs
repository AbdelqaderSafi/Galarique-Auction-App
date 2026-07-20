// Live HTTP test matrix for the favorites/follows module. Run with: node scripts/test-favorites.mjs
// Requires the server running on :3000 and seed-favorites-test.ts already run.
const BASE = 'http://localhost:3000';

// From the latest seed-favorites-test run:
const IDS = {
  sellerId: '73fe3650-d11a-4fae-a9d7-5488aecc4150',
  plainId: '9fa9acd6-1695-4c89-8e2c-573423f55784',
  actorId: '76c90e23-2dcc-4e1a-b971-31fed3c2152f',
  liveAuctionId: '6a728adf-5f2e-4b3c-9a9d-9862beb344a4',
  draftAuctionId: '044059fc-f259-4c7b-84e8-a5d8834f4de8',
  randomId: '00000000-0000-0000-0000-000000000000',
};
const USERS = {
  seller: 'seller.favs@test.local',
  plain: 'plain.favs@test.local',
  actor: 'actor.favs@test.local',
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

async function main() {
  const t = {
    seller: await login(USERS.seller),
    plain: await login(USERS.plain),
    actor: await login(USERS.actor),
  };
  console.log('logged in seller/plain/actor\n');

  // ================= Favorite Auctions =================
  let r;
  r = await req('POST', `/favorites/${IDS.liveAuctionId}`); // no token
  check('POST favorites', 'guest no token -> 401', r.status === 401, `got ${r.status}`);

  r = await req('POST', `/favorites/${IDS.draftAuctionId}`, { token: t.actor });
  check('POST favorites', 'DRAFT (non-public) auction -> 404', r.status === 404, `got ${r.status}`);

  r = await req('POST', `/favorites/${IDS.randomId}`, { token: t.actor });
  check('POST favorites', 'random auction id -> 404', r.status === 404, `got ${r.status}`);

  r = await req('POST', `/favorites/${IDS.liveAuctionId}`, { token: t.actor });
  check('POST favorites', 'add LIVE auction -> 201 favorited:true', r.status === 201 && r.json?.favorited === true,
    `got ${r.status}: ${JSON.stringify(r.json)}`);

  r = await req('POST', `/favorites/${IDS.liveAuctionId}`, { token: t.actor });
  check('POST favorites', 'add again (idempotent) -> 201 favorited:true', r.status === 201 && r.json?.favorited === true,
    `got ${r.status}: ${JSON.stringify(r.json)}`);

  r = await req('GET', '/favorites'); // no token
  check('GET favorites', 'guest no token -> 401', r.status === 401, `got ${r.status}`);

  r = await req('GET', '/favorites', { token: t.actor });
  const aucItems = r.json?.items;
  const aucListOk = Array.isArray(aucItems) && aucItems.length === 1 && aucItems[0].id === IDS.liveAuctionId
    && aucItems[0].status === 'LIVE' && typeof aucItems[0].currentPrice === 'string';
  check('GET favorites', 'actor sees 1 favorite auction with shape', r.status === 200 && aucListOk,
    `got ${r.status}: ${JSON.stringify(r.json)}`);

  r = await req('GET', '/favorites', { token: t.plain });
  check('GET favorites', 'plain user sees empty list', r.status === 200 && r.json?.items?.length === 0,
    `got ${r.status}: ${JSON.stringify(r.json)}`);

  r = await req('DELETE', `/favorites/${IDS.liveAuctionId}`); // no token
  check('DELETE favorites', 'guest no token -> 401', r.status === 401, `got ${r.status}`);

  r = await req('DELETE', `/favorites/${IDS.liveAuctionId}`, { token: t.actor });
  check('DELETE favorites', 'remove real favorite -> 200 favorited:false', r.status === 200 && r.json?.favorited === false,
    `got ${r.status}: ${JSON.stringify(r.json)}`);

  r = await req('DELETE', `/favorites/${IDS.randomId}`, { token: t.actor });
  check('DELETE favorites', 'remove non-existent (idempotent) -> 200 favorited:false', r.status === 200 && r.json?.favorited === false,
    `got ${r.status}: ${JSON.stringify(r.json)}`);

  r = await req('GET', '/favorites', { token: t.actor });
  check('GET favorites', 'actor list empty after removal', r.status === 200 && r.json?.items?.length === 0,
    `got ${r.status}: ${JSON.stringify(r.json)}`);

  // ================= Follows =================
  r = await req('POST', `/follows/${IDS.sellerId}`); // no token
  check('POST follows', 'guest no token -> 401', r.status === 401, `got ${r.status}`);

  r = await req('POST', `/follows/${IDS.actorId}`, { token: t.actor }); // self
  check('POST follows', 'follow self -> 400', r.status === 400, `got ${r.status}: ${r.json?.message}`);

  r = await req('POST', `/follows/${IDS.plainId}`, { token: t.actor }); // not a seller
  check('POST follows', 'follow non-seller -> 404', r.status === 404, `got ${r.status}: ${r.json?.message}`);

  r = await req('POST', `/follows/${IDS.randomId}`, { token: t.actor });
  check('POST follows', 'follow random id -> 404', r.status === 404, `got ${r.status}`);

  r = await req('POST', `/follows/${IDS.sellerId}`, { token: t.actor });
  check('POST follows', 'follow real seller -> 201 following:true', r.status === 201 && r.json?.following === true,
    `got ${r.status}: ${JSON.stringify(r.json)}`);

  r = await req('POST', `/follows/${IDS.sellerId}`, { token: t.actor });
  check('POST follows', 'follow again (idempotent) -> 201 following:true', r.status === 201 && r.json?.following === true,
    `got ${r.status}: ${JSON.stringify(r.json)}`);

  r = await req('GET', '/follows'); // no token
  check('GET follows', 'guest no token -> 401', r.status === 401, `got ${r.status}`);

  r = await req('GET', '/follows', { token: t.actor });
  const followItems = r.json?.items;
  const followListOk = Array.isArray(followItems) && followItems.length === 1 && followItems[0].id === IDS.sellerId
    && typeof followItems[0].fullName === 'string';
  check('GET follows', 'actor sees 1 followed seller with shape', r.status === 200 && followListOk,
    `got ${r.status}: ${JSON.stringify(r.json)}`);

  r = await req('GET', '/follows', { token: t.plain });
  check('GET follows', 'plain user sees empty list', r.status === 200 && r.json?.items?.length === 0,
    `got ${r.status}: ${JSON.stringify(r.json)}`);

  r = await req('DELETE', `/follows/${IDS.sellerId}`); // no token
  check('DELETE follows', 'guest no token -> 401', r.status === 401, `got ${r.status}`);

  r = await req('DELETE', `/follows/${IDS.sellerId}`, { token: t.actor });
  check('DELETE follows', 'unfollow real seller -> 200 following:false', r.status === 200 && r.json?.following === false,
    `got ${r.status}: ${JSON.stringify(r.json)}`);

  r = await req('DELETE', `/follows/${IDS.randomId}`, { token: t.actor });
  check('DELETE follows', 'unfollow non-existent (idempotent) -> 200 following:false', r.status === 200 && r.json?.following === false,
    `got ${r.status}: ${JSON.stringify(r.json)}`);

  r = await req('GET', '/follows', { token: t.actor });
  check('GET follows', 'actor list empty after unfollow', r.status === 200 && r.json?.items?.length === 0,
    `got ${r.status}: ${JSON.stringify(r.json)}`);

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
