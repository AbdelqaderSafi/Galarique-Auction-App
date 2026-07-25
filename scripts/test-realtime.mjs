// Live HTTP + SSE test for the realtime module. Run with:
//   node scripts/test-realtime.mjs
// Requires the server running on :3000 and seed-realtime-test.ts already run,
// with AUCTION_ID, TOKEN_A, TOKEN_B (and optionally CLOSE_AUCTION_ID) env vars
// set from the seed output.
import 'dotenv/config';
import pg from 'pg';

const BASE = process.env.BASE_URL || 'http://localhost:3000';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
}

// Open an SSE stream and collect parsed data objects until `predicate` matches
// or `timeoutMs` elapses. Uses fetch streaming (no EventSource dependency).
async function collectSse(path, token, predicate, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const res = await fetch(BASE + path, {
    headers: { Authorization: `Bearer ${token}` },
    signal: ctrl.signal,
  });
  if (!res.ok) {
    clearTimeout(timer);
    throw new Error(`SSE ${path} -> HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // split SSE messages on the blank-line separator
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = raw.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const data = JSON.parse(line.slice(5).trim());
        if (data.type === 'ping') continue;
        if (predicate(data)) {
          ctrl.abort();
          clearTimeout(timer);
          return data;
        }
      }
    }
  } catch (e) {
    if (ctrl.signal.aborted) return null; // timeout
    throw e;
  }
  clearTimeout(timer);
  return null;
}

async function postBid(token, auctionId, amount) {
  const res = await fetch(`${BASE}/auctions/${auctionId}/bids`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount }),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json };
}

async function login(email, password) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`admin login failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json.token;
}

async function main() {
  const { AUCTION_ID, TOKEN_A, TOKEN_B, USER_B_ID, CLOSE_AUCTION_ID } = process.env;
  if (!AUCTION_ID || !TOKEN_A || !TOKEN_B) {
    throw new Error('Set AUCTION_ID, TOKEN_A, TOKEN_B env vars from the seed output');
  }

  // ================= 1) auction stream receives `bid` =================
  const bidPromise = collectSse(
    `/auctions/${AUCTION_ID}/stream`,
    TOKEN_A,
    (d) => d.type === 'bid',
    5000,
  );
  await new Promise((r) => setTimeout(r, 500)); // let the subscription open
  const bidRes = await postBid(TOKEN_B, AUCTION_ID, 100);
  check(
    'B\'s bid HTTP call succeeds',
    bidRes.status === 200 || bidRes.status === 201,
    `got ${bidRes.status}: ${JSON.stringify(bidRes.json)}`,
  );
  const bidEvent = await bidPromise;
  check(
    'auction stream receives bid event within 5s',
    !!bidEvent && bidEvent.type === 'bid' && bidEvent.amount === '100.00',
    JSON.stringify(bidEvent),
  );

  // ================= 2) personal stream receives `outbid` =================
  const outbidPromise = collectSse('/me/stream', TOKEN_A, (d) => d.type === 'outbid', 5000);
  await new Promise((r) => setTimeout(r, 500));
  // A takes the lead (bids 110), then B outbids A (bids 120) -> A must get `outbid`
  const aBid = await postBid(TOKEN_A, AUCTION_ID, 110);
  check(
    'A\'s bid HTTP call succeeds (takes the lead)',
    aBid.status === 200 || aBid.status === 201,
    `got ${aBid.status}: ${JSON.stringify(aBid.json)}`,
  );
  const bBid2 = await postBid(TOKEN_B, AUCTION_ID, 120);
  check(
    'B\'s second bid HTTP call succeeds (outbids A)',
    bBid2.status === 200 || bBid2.status === 201,
    `got ${bBid2.status}: ${JSON.stringify(bBid2.json)}`,
  );
  const outbidEvent = await outbidPromise;
  check(
    'personal stream receives outbid event within 5s',
    !!outbidEvent && outbidEvent.type === 'outbid' && outbidEvent.auctionId === AUCTION_ID,
    JSON.stringify(outbidEvent),
  );

  // ================= 3) auth/404 edge cases =================
  const noAuth = await fetch(`${BASE}/me/stream`);
  check('no token -> 401', noAuth.status === 401, `status ${noAuth.status}`);

  const notFound = await fetch(`${BASE}/auctions/00000000-0000-0000-0000-000000000000/stream`, {
    headers: { Authorization: `Bearer ${TOKEN_A}` },
  });
  check('missing auction -> 404', notFound.status === 404, `status ${notFound.status}`);

  // ================= 4) optional: closed + won on scheduler close =================
  // The close-test auction is seeded with a far-out endTime (5 min) so the bid
  // below always succeeds regardless of any gap between seeding and running this
  // script. Right after the winning bid, we force its endTime into the past via
  // a direct SQL update (DATABASE_URL) — per the task brief — so triggering the
  // scheduler closes it deterministically, with no race against the background
  // cron (which would otherwise close it out from under us at an unpredictable time).
  if (CLOSE_AUCTION_ID && process.env.DATABASE_URL) {
    let pgClient;
    try {
      // B places the winning (and only) bid on the far-out-endTime auction.
      const closeBid = await postBid(TOKEN_B, CLOSE_AUCTION_ID, 100);
      check(
        'close-test: B\'s bid on close-test auction succeeds',
        closeBid.status === 200 || closeBid.status === 201,
        `got ${closeBid.status}: ${JSON.stringify(closeBid.json)}`,
      );

      pgClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await pgClient.connect();
      await pgClient.query(
        `UPDATE "Auction" SET "endTime" = now() - interval '1 second' WHERE id = $1;`,
        [CLOSE_AUCTION_ID],
      );
      await pgClient.end();
      pgClient = undefined;

      // Subscribe BEFORE triggering the tick so we can't miss the broadcast.
      const closedPromise = collectSse(
        `/auctions/${CLOSE_AUCTION_ID}/stream`,
        TOKEN_A,
        (d) => d.type === 'closed',
        10000,
      );
      const wonPromise = collectSse('/me/stream', TOKEN_B, (d) => d.type === 'won', 10000);
      await new Promise((r) => setTimeout(r, 500)); // let both subscriptions open

      const adminEmail = process.env.ADMIN_EMAIL;
      const adminPassword = process.env.ADMIN_PASSWORD;
      if (adminEmail && adminPassword) {
        const adminToken = await login(adminEmail, adminPassword);
        const tickRes = await fetch(`${BASE}/scheduler/run`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${adminToken}` },
        });
        check('scheduler tick (admin) -> 200', tickRes.status === 200, `got ${tickRes.status}`);
      } else {
        check(
          'scheduler tick (admin) -> 200',
          false,
          'ADMIN_EMAIL/ADMIN_PASSWORD not set — relying on the background cron instead',
        );
      }

      const closedEvent = await closedPromise;
      check(
        'auction stream receives closed event',
        !!closedEvent && closedEvent.type === 'closed' && closedEvent.status === 'ENDED',
        JSON.stringify(closedEvent),
      );

      const wonEvent = await wonPromise;
      check(
        'winner personal stream receives won event',
        !!wonEvent && wonEvent.type === 'won' && wonEvent.auctionId === CLOSE_AUCTION_ID,
        JSON.stringify(wonEvent),
      );
    } catch (e) {
      check('closed/won extension', false, `threw: ${e.message}`);
    } finally {
      if (pgClient) await pgClient.end().catch(() => {});
    }
  } else {
    console.log('(skipping closed/won extension — CLOSE_AUCTION_ID or DATABASE_URL not set)');
  }

  // ---- summary ----
  const pass = results.filter((x) => x.ok).length;
  console.log(`\n${pass}/${results.length} passed`);
  if (pass !== results.length) {
    console.log('FAILURES:');
    results.filter((x) => !x.ok).forEach((x) => console.log(`  FAIL ${x.name} -> ${x.detail}`));
  }
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('runner error:', e);
  process.exit(2);
});
