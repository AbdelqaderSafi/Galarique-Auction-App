// Comprehensive black-box System Test: exercises auth, seller verification, account
// settings, the full auctions wizard (real multipart image upload to ImageKit),
// wallet (real Stripe test-mode calls), categories, and admin/role guards end-to-end
// over real HTTP against a running server — no mocks, no direct DB seeding (this
// script creates all of its own data through the public API, like a real client would).
//
// Run with: node scripts/test-system-e2e.mjs
// Requires:
//   - the server running and reachable at BASE_URL (default http://localhost:3100)
//   - a clean galleryq_system_test database (see scripts/reset-system-test-db.ts)
//   - `npm run seed` already run against that DB (creates the ADMIN_* user)
//   - ADMIN_EMAIL / ADMIN_PASSWORD env vars (from .env.system-test)
//   - SERVER_LOG env var pointing at the server's stdout log file, so this script
//     can read the OTP codes MailService logs when BREVO_API_KEY is unset
//     (see .env.system-test — "Code (dev only): 123456")
import { readFileSync, existsSync } from 'fs';

const BASE = process.env.BASE_URL || 'http://localhost:3100';
const SERVER_LOG = process.env.SERVER_LOG || '';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PASSWORD = 'Test1234!';
const NEW_PASSWORD = 'Test5678!';
const RESET_PASSWORD = 'Test9999!';

const EMAILS = {
  buyer: 'sysbuyer@test.local',
  second: 'syssecond@test.local',
};

// 1x1 transparent PNG, embedded so this script needs no fixture files on disk.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const results = [];
function check(endpoint, name, ok, detail) {
  results.push({ endpoint, name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} [${endpoint}] ${name}${detail ? ' — ' + detail : ''}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function req(method, path, { token, body, form } = {}) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  let payload;
  if (form) {
    // Built as one pre-computed Buffer (not a FormData/stream) — sending a whole
    // request body up-front avoids intermittent multipart-over-keepalive framing
    // issues seen with fetch's native FormData streaming against this server.
    headers['Content-Type'] = form.contentType;
    payload = form.buffer;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json };
}

async function login(email, password) {
  const { status, json } = await req('POST', '/auth/login', { body: { email, password } });
  if (status !== 200 && status !== 201) {
    throw new Error(`login ${email} failed: ${status} ${JSON.stringify(json)}`);
  }
  return json.token;
}

// Windows PowerShell's `*>` redirection writes UTF-16LE (with BOM) by default,
// so we can't just assume utf-8 when reading the server's log file back.
function readLogText() {
  if (!SERVER_LOG || !existsSync(SERVER_LOG)) return '';
  const buf = readFileSync(SERVER_LOG);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString('utf16le', 2);
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString('utf8', 3);
  }
  return buf.toString('utf8');
}

function logLength() {
  return readLogText().length;
}

// Polls the server log file for a new "Code (dev only): 123456" line written
// after `since` (a length watermark from logLength()). MailService logs this
// synchronously when BREVO_API_KEY is unset, so the code always shows up here
// instead of actually being emailed.
async function readNewOtpCode(since) {
  for (let i = 0; i < 30; i++) {
    const text = readLogText();
    if (text.length > since) {
      const matches = [...text.matchAll(/Code \(dev only\): (\d{6})/g)];
      if (matches.length) return matches[matches.length - 1][1];
    }
    await sleep(200);
  }
  return null;
}

// Builds a raw multipart/form-data body as a single Buffer (fields + one image
// part) instead of a FormData/stream, so the whole request is sent as one shot.
function buildAuctionForm(overrides = {}) {
  const boundary = `----galleryqSysTest${Math.random().toString(16).slice(2)}`;
  const fields = {
    category: 'ART',
    title: '[SYS] Test Painting',
    description: 'A system-test auction created end-to-end.',
    startingPrice: '100',
    durationDays: '1',
    saveAsDraft: 'true',
    customFields: JSON.stringify([
      { label: 'Artist', value: 'Van Gogh' },
      { label: 'Edition', value: '12/100' },
    ]),
    ...overrides,
  };
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
        'utf-8',
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="mainImage"; filename="main.png"\r\nContent-Type: image/png\r\n\r\n`,
      'utf-8',
    ),
  );
  parts.push(Buffer.from(TINY_PNG_BASE64, 'base64'));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8'));
  return { buffer: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function main() {
  // ================= Categories (public) =================
  let r = await req('GET', '/categories');
  const cats = r.json;
  check(
    'GET categories',
    'public list of 8 categories incl. ART',
    r.status === 200 && Array.isArray(cats) && cats.length === 8 &&
      cats.some((c) => c.value === 'ART' && c.label === 'Art'),
    `got ${r.status}: ${JSON.stringify(cats)}`,
  );

  // ================= Auth: register -> verify -> login =================
  r = await req('POST', '/auth/register', { body: { fullName: 'A', email: EMAILS.buyer, password: PASSWORD } });
  check('POST register', 'fullName too short -> 400 (Zod)', r.status === 400, `got ${r.status}`);

  let sinceLen = logLength();
  r = await req('POST', '/auth/register', {
    body: { fullName: 'Sys Buyer', email: EMAILS.buyer, password: PASSWORD },
  });
  check('POST register', 'valid registration -> 200', r.status === 200, `got ${r.status}: ${JSON.stringify(r.json)}`);

  r = await req('POST', '/auth/verify-email', { body: { email: EMAILS.buyer, code: '000000' } });
  check('POST verify-email', 'wrong code -> 400', r.status === 400, `got ${r.status}: ${r.json?.message}`);

  let code = await readNewOtpCode(sinceLen);
  check('mail log', 'captured registration OTP from server log', !!code, code ? `code=${code}` : 'no SERVER_LOG match');

  r = await req('POST', '/auth/verify-email', { body: { email: EMAILS.buyer, code: code || '000000' } });
  const verifyOk = r.status === 201 || r.status === 200;
  check('POST verify-email', 'correct code -> creates user + token', verifyOk && !!r.json?.token,
    `got ${r.status}: ${JSON.stringify(r.json)}`);
  let buyerId = r.json?.userData?.id;
  let buyerToken = r.json?.token;

  r = await req('POST', '/auth/register', { body: { fullName: 'Sys Buyer', email: EMAILS.buyer, password: PASSWORD } });
  check('POST register', 'already-verified email -> 409', r.status === 409, `got ${r.status}`);

  r = await req('POST', '/auth/login', { body: { email: EMAILS.buyer, password: 'WrongPass1' } });
  check('POST login', 'wrong password -> 401', r.status === 401, `got ${r.status}`);

  buyerToken = await login(EMAILS.buyer, PASSWORD);
  check('POST login', 'correct password -> token', !!buyerToken, 'got token');

  // ================= Auth: validate / change-password / forgot-reset =================
  r = await req('GET', '/auth/validate');
  check('GET validate', 'no token -> 401', r.status === 401, `got ${r.status}`);

  r = await req('GET', '/auth/validate', { token: buyerToken });
  check('GET validate', 'valid token -> 200, roles=[BUYER]', r.status === 200 &&
    JSON.stringify(r.json?.userData?.roles) === JSON.stringify(['BUYER']),
    `got ${r.status}: ${JSON.stringify(r.json?.userData?.roles)}`);

  r = await req('POST', '/auth/change-password', {
    token: buyerToken,
    body: { currentPassword: 'WrongPass1', newPassword: NEW_PASSWORD },
  });
  check('POST change-password', 'wrong current -> 400', r.status === 400, `got ${r.status}: ${r.json?.message}`);

  r = await req('POST', '/auth/change-password', {
    token: buyerToken,
    body: { currentPassword: PASSWORD, newPassword: PASSWORD },
  });
  check('POST change-password', 'same as current -> 400', r.status === 400, `got ${r.status}: ${r.json?.message}`);

  r = await req('POST', '/auth/change-password', {
    token: buyerToken,
    body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
  });
  check('POST change-password', 'valid change -> 200', r.status === 200, `got ${r.status}`);

  r = await req('POST', '/auth/login', { body: { email: EMAILS.buyer, password: PASSWORD } });
  check('POST login', 'old password now rejected -> 401', r.status === 401, `got ${r.status}`);

  buyerToken = await login(EMAILS.buyer, NEW_PASSWORD);
  check('POST login', 'new password works -> token', !!buyerToken, 'got token');

  r = await req('POST', '/auth/forgot-password', { body: { email: 'nobody@test.local' } });
  check('POST forgot-password', 'unknown email -> 200 generic (no enumeration)', r.status === 200, `got ${r.status}`);

  sinceLen = logLength();
  r = await req('POST', '/auth/forgot-password', { body: { email: EMAILS.buyer } });
  check('POST forgot-password', 'known email -> 200', r.status === 200, `got ${r.status}`);

  const resetCode = await readNewOtpCode(sinceLen);
  check('mail log', 'captured password-reset OTP from server log', !!resetCode, resetCode ? `code=${resetCode}` : 'no SERVER_LOG match');

  r = await req('POST', '/auth/reset-password', {
    body: { email: EMAILS.buyer, code: '000000', newPassword: RESET_PASSWORD },
  });
  check('POST reset-password', 'wrong code -> 400', r.status === 400, `got ${r.status}`);

  r = await req('POST', '/auth/reset-password', {
    body: { email: EMAILS.buyer, code: resetCode || '000000', newPassword: RESET_PASSWORD },
  });
  check('POST reset-password', 'correct code -> 200', r.status === 200, `got ${r.status}`);

  buyerToken = await login(EMAILS.buyer, RESET_PASSWORD);
  check('POST login', 'reset password works -> token', !!buyerToken, 'got token');

  r = await req('POST', '/auth/google', { body: { idToken: 'not-a-real-google-token' } });
  check('POST google', 'garbage idToken -> 401', r.status === 401, `got ${r.status}`);

  // ================= Register a second user (role-guard + username-conflict foil) =================
  sinceLen = logLength();
  await req('POST', '/auth/register', { body: { fullName: 'Sys Second', email: EMAILS.second, password: PASSWORD } });
  const secondCode = await readNewOtpCode(sinceLen);
  r = await req('POST', '/auth/verify-email', { body: { email: EMAILS.second, code: secondCode || '000000' } });
  let secondToken = r.json?.token;
  check('POST verify-email', 'second user created', !!secondToken, `got ${r.status}`);

  // ================= User settings (PATCH /users/me) =================
  r = await req('PATCH', '/users/me', { body: { username: 'sysbuyer1' } });
  check('PATCH users/me', 'no token -> 401', r.status === 401, `got ${r.status}`);

  r = await req('PATCH', '/users/me', { token: buyerToken, body: {} });
  check('PATCH users/me', 'empty body -> 400 (at least one field)', r.status === 400, `got ${r.status}`);

  r = await req('PATCH', '/users/me', {
    token: buyerToken,
    body: { dateOfBirth: '2999-01-01' },
  });
  check('PATCH users/me', 'future dateOfBirth -> 400', r.status === 400, `got ${r.status}`);

  r = await req('PATCH', '/users/me', {
    token: buyerToken,
    body: { username: 'sysbuyer1', dateOfBirth: '2000-05-15', phoneNumber: '+970599123456' },
  });
  check('PATCH users/me', 'valid update -> 200', r.status === 200 && r.json?.username === 'sysbuyer1',
    `got ${r.status}: ${JSON.stringify(r.json)}`);

  await req('PATCH', '/users/me', { token: secondToken, body: { username: 'systaken' } });
  r = await req('PATCH', '/users/me', { token: buyerToken, body: { username: 'systaken' } });
  check('PATCH users/me', 'duplicate username -> 409', r.status === 409, `got ${r.status}`);

  // ================= Seller verification (buyer -> seller) =================
  r = await req('POST', '/seller/request-verification', { token: buyerToken, body: { phoneNumber: '+1-555-0000' } });
  check('POST seller/request-verification', 'invalid (non-Palestinian) phone -> 400', r.status === 400, `got ${r.status}`);

  r = await req('POST', '/seller/request-verification', { token: buyerToken, body: { phoneNumber: '+970591234567' } });
  const sellerCode = r.json?.code;
  check('POST seller/request-verification', 'valid PS phone -> 200, code in response (simulate mode)',
    r.status === 200 && !!sellerCode, `got ${r.status}: ${JSON.stringify(r.json)}`);

  r = await req('POST', '/seller/verify-phone', { token: buyerToken, body: { code: '000000' } });
  check('POST seller/verify-phone', 'wrong code -> 400', r.status === 400, `got ${r.status}`);

  r = await req('POST', '/seller/verify-phone', { token: buyerToken, body: { code: sellerCode || '000000' } });
  check('POST seller/verify-phone', 'correct code -> 200, grants SELLER', r.status === 200, `got ${r.status}: ${JSON.stringify(r.json)}`);

  buyerToken = await login(EMAILS.buyer, RESET_PASSWORD);
  r = await req('GET', '/auth/validate', { token: buyerToken });
  check('GET validate', 'roles now include SELLER', r.json?.userData?.roles?.includes('SELLER'),
    JSON.stringify(r.json?.userData?.roles));

  r = await req('POST', '/seller/request-verification', { token: buyerToken, body: { phoneNumber: '+970591234567' } });
  check('POST seller/request-verification', 'already a seller -> 409', r.status === 409, `got ${r.status}`);

  r = await req('POST', '/seller/resend', { token: buyerToken });
  check('POST seller/resend', 'no pending verification left -> 404', r.status === 404, `got ${r.status}`);

  r = await req('GET', '/seller/whatsapp/status', { token: buyerToken });
  check('GET seller/whatsapp/status', 'non-admin -> 403', r.status === 403, `got ${r.status}`);

  const adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  r = await req('GET', '/seller/whatsapp/status', { token: adminToken });
  check('GET seller/whatsapp/status', 'admin -> 200', r.status === 200, `got ${r.status}: ${JSON.stringify(r.json)}`);

  // ================= Auctions wizard =================
  r = await req('POST', '/auctions', { token: secondToken, form: buildAuctionForm() });
  check('POST auctions', 'non-seller -> 403', r.status === 403, `got ${r.status}`);

  r = await req('POST', '/auctions', { token: buyerToken, body: { category: 'ART' } });
  check('POST auctions', 'no mainImage file -> 400', r.status === 400, `got ${r.status}: ${r.json?.message}`);

  r = await req('POST', '/auctions', { token: buyerToken, form: buildAuctionForm({ category: 'NOT_A_CATEGORY' }) });
  check('POST auctions', 'invalid category -> 400 (Zod)', r.status === 400, `got ${r.status}`);

  // --- Auction 1: full lifecycle (draft -> submit -> reject -> edit/auto-resubmit -> approve -> LIVE -> admin cancel) ---
  r = await req('POST', '/auctions', {
    token: buyerToken,
    form: buildAuctionForm({ title: '[SYS] Lifecycle Painting', saveAsDraft: 'true' }),
  });
  const auction1Ok = r.status === 201 && r.json?.status === 'DRAFT' && r.json?.object?.mainImage?.startsWith('http');
  check('POST auctions', 'create DRAFT with real ImageKit upload -> 201', auction1Ok,
    `got ${r.status}: ${JSON.stringify(r.json)}`);
  const auction1 = r.json?.id;

  check('POST auctions', 'minBidIncrement is fixed at 10 (not a seller input)',
    Number(r.json?.minBidIncrement) === 10, `got ${r.json?.minBidIncrement}`);
  check('POST auctions', 'seller-defined customFields are stored in order',
    JSON.stringify(r.json?.object?.customFields) ===
      JSON.stringify([{ label: 'Artist', value: 'Van Gogh' }, { label: 'Edition', value: '12/100' }]),
    `got ${JSON.stringify(r.json?.object?.customFields)}`);

  // minBidIncrement is ignored even if a client still sends it
  r = await req('POST', '/auctions', {
    token: buyerToken,
    form: buildAuctionForm({ title: '[SYS] Ignored Increment', minBidIncrement: '25' }),
  });
  check('POST auctions', 'a client-sent minBidIncrement is ignored -> still 10',
    r.status === 201 && Number(r.json?.minBidIncrement) === 10,
    `got ${r.status}: ${r.json?.minBidIncrement}`);
  await req('DELETE', `/auctions/${r.json?.id}`, { token: buyerToken });

  // customFields validation (limits + malformed JSON)
  r = await req('POST', '/auctions', {
    token: buyerToken,
    form: buildAuctionForm({ customFields: '[{"label":"a","value":"1"},{"label":"A","value":"2"}]' }),
  });
  check('POST auctions', 'duplicate customFields labels -> 400', r.status === 400, `got ${r.status}`);

  r = await req('POST', '/auctions', {
    token: buyerToken,
    form: buildAuctionForm({
      customFields: JSON.stringify(
        Array.from({ length: 6 }, (_, i) => ({ label: `F${i}`, value: 'x' })),
      ),
    }),
  });
  check('POST auctions', 'more than 5 customFields -> 400', r.status === 400, `got ${r.status}`);

  r = await req('POST', '/auctions', {
    token: buyerToken,
    form: buildAuctionForm({ customFields: 'not-json' }),
  });
  check('POST auctions', 'malformed customFields JSON -> 400', r.status === 400, `got ${r.status}`);

  r = await req('GET', '/auctions/mine', { token: buyerToken });
  check('GET auctions/mine', 'seller sees the new draft', r.status === 200 && r.json?.some((a) => a.id === auction1),
    `got ${r.status}, count ${r.json?.length}`);

  r = await req('GET', `/auctions/${auction1}`);
  check('GET auctions/:id', 'DRAFT is not public -> 404', r.status === 404, `got ${r.status}`);

  r = await req('POST', `/auctions/${auction1}/submit`, { token: buyerToken });
  check('POST auctions/:id/submit', 'DRAFT -> PENDING_REVIEW', r.status === 200 && r.json?.status === 'PENDING_REVIEW',
    `got ${r.status}: ${r.json?.status}`);

  r = await req('GET', '/auctions/admin/pending', { token: buyerToken });
  check('GET auctions/admin/pending', 'non-admin -> 403', r.status === 403, `got ${r.status}`);

  r = await req('GET', '/auctions/admin/pending', { token: adminToken });
  check('GET auctions/admin/pending', 'admin sees pending auction', r.status === 200 && r.json?.some((a) => a.id === auction1),
    `got ${r.status}, count ${r.json?.length}`);

  r = await req('POST', `/auctions/${auction1}/reject`, { token: adminToken, body: { reason: 'Needs better photos.' } });
  check('POST auctions/:id/reject', 'admin rejects with reason -> REJECTED', r.status === 200 && r.json?.status === 'REJECTED',
    `got ${r.status}: ${r.json?.status}`);

  r = await req('PATCH', `/auctions/${auction1}`, { token: buyerToken, body: { title: '[SYS] Lifecycle Painting (fixed)' } });
  check('PATCH auctions/:id', 'seller edits a REJECTED auction -> auto-resubmits to PENDING_REVIEW',
    r.status === 200 && r.json?.status === 'PENDING_REVIEW' && r.json?.object?.title.endsWith('(fixed)'),
    `got ${r.status}: ${JSON.stringify({ status: r.json?.status, title: r.json?.object?.title })}`);

  check('PATCH auctions/:id', 'an untouched customFields survives an unrelated edit',
    JSON.stringify(r.json?.object?.customFields) ===
      JSON.stringify([{ label: 'Artist', value: 'Van Gogh' }, { label: 'Edition', value: '12/100' }]),
    `got ${JSON.stringify(r.json?.object?.customFields)}`);

  r = await req('PATCH', `/auctions/${auction1}`, {
    token: buyerToken,
    body: { customFields: [{ label: 'Provenance', value: 'Private collection, Paris' }] },
  });
  check('PATCH auctions/:id', 'customFields are replaced wholesale',
    r.status === 200 &&
      JSON.stringify(r.json?.object?.customFields) ===
        JSON.stringify([{ label: 'Provenance', value: 'Private collection, Paris' }]),
    `got ${r.status}: ${JSON.stringify(r.json?.object?.customFields)}`);

  r = await req('PATCH', `/auctions/${auction1}`, { token: buyerToken, body: { minBidIncrement: 25 } });
  check('PATCH auctions/:id', 'minBidIncrement cannot be changed after creation -> stays 10',
    r.status === 200 && Number(r.json?.minBidIncrement) === 10,
    `got ${r.status}: ${r.json?.minBidIncrement}`);

  r = await req('PATCH', `/auctions/${auction1}`, {
    token: buyerToken,
    body: { customFields: [{ label: 'x'.repeat(31), value: 'too long a label' }] },
  });
  check('PATCH auctions/:id', 'a customFields label over 30 chars -> 400', r.status === 400, `got ${r.status}`);

  r = await req('PATCH', `/auctions/${auction1}`, { token: buyerToken, body: { customFields: [] } });
  check('PATCH auctions/:id', 'an empty array clears customFields',
    r.status === 200 && Array.isArray(r.json?.object?.customFields) && r.json.object.customFields.length === 0,
    `got ${r.status}: ${JSON.stringify(r.json?.object?.customFields)}`);

  r = await req('POST', `/auctions/${auction1}/approve`, { token: adminToken });
  check('POST auctions/:id/approve', 'admin approves -> LIVE', r.status === 200 && r.json?.status === 'LIVE',
    `got ${r.status}: ${r.json?.status}`);

  r = await req('GET', '/auctions?category=ART&sort=newest');
  check('GET auctions', 'public browse (filter+sort) includes the LIVE auction',
    r.status === 200 && r.json?.items?.some((a) => a.id === auction1), `got ${r.status}, total ${r.json?.total}`);

  r = await req('GET', `/auctions/${auction1}`);
  check('GET auctions/:id', 'public detail now visible, viewsCount incremented', r.status === 200 && r.json?.viewsCount >= 1,
    `got ${r.status}: viewsCount=${r.json?.viewsCount}`);

  r = await req('POST', `/auctions/${auction1}/cancel`, { token: buyerToken });
  check('POST auctions/:id/cancel', 'seller cannot cancel a LIVE auction -> 400', r.status === 400, `got ${r.status}`);

  r = await req('POST', `/auctions/${auction1}/cancel`, { token: adminToken });
  check('POST auctions/:id/cancel', 'admin cancels a LIVE auction -> CANCELLED', r.status === 200 && r.json?.status === 'CANCELLED',
    `got ${r.status}: ${r.json?.status}`);

  // --- Auction 2: draft delete ---
  r = await req('POST', '/auctions', { token: buyerToken, form: buildAuctionForm({ title: '[SYS] Throwaway Draft' }) });
  const auction2 = r.json?.id;
  check('POST auctions', 'second draft created', r.status === 201, `got ${r.status}`);

  r = await req('DELETE', `/auctions/${auction2}`, { token: secondToken });
  check('DELETE auctions/:id', 'non-owner -> 403', r.status === 403, `got ${r.status}`);

  r = await req('DELETE', `/auctions/${auction2}`, { token: buyerToken });
  check('DELETE auctions/:id', 'owner deletes own draft -> 200', r.status === 200, `got ${r.status}`);

  r = await req('GET', '/auctions/mine', { token: buyerToken });
  check('GET auctions/mine', 'deleted draft no longer listed', !r.json?.some((a) => a.id === auction2), `count ${r.json?.length}`);

  // --- Auction 3: submit-immediately (saveAsDraft:false) + seller cancel while PENDING ---
  r = await req('POST', '/auctions', {
    token: buyerToken,
    form: buildAuctionForm({ title: '[SYS] Direct Submit', saveAsDraft: 'false' }),
  });
  const auction3 = r.json?.id;
  check('POST auctions', 'saveAsDraft:false -> straight to PENDING_REVIEW', r.status === 201 && r.json?.status === 'PENDING_REVIEW',
    `got ${r.status}: ${r.json?.status}`);

  r = await req('DELETE', `/auctions/${auction3}`, { token: buyerToken });
  check('DELETE auctions/:id', 'non-draft cannot be deleted -> 400', r.status === 400, `got ${r.status}`);

  r = await req('POST', `/auctions/${auction3}/cancel`, { token: buyerToken });
  check('POST auctions/:id/cancel', 'seller cancels while PENDING_REVIEW -> CANCELLED', r.status === 200 && r.json?.status === 'CANCELLED',
    `got ${r.status}: ${r.json?.status}`);

  // --- Auction 4: full approve -> admin force-end (no bids -> UNSOLD, object back to AVAILABLE) ---
  r = await req('POST', '/auctions', { token: buyerToken, form: buildAuctionForm({ title: '[SYS] Force-end me' }) });
  const auction4 = r.json?.id;
  await req('POST', `/auctions/${auction4}/submit`, { token: buyerToken });
  r = await req('POST', `/auctions/${auction4}/approve`, { token: adminToken });
  check('POST auctions/:id/approve', 'auction 4 approved -> LIVE', r.status === 200 && r.json?.status === 'LIVE', `got ${r.status}`);

  r = await req('POST', `/auctions/${auction4}/force-end`, { token: buyerToken });
  check('POST auctions/:id/force-end', 'non-admin -> 403', r.status === 403, `got ${r.status}`);

  r = await req('POST', `/auctions/${auction4}/force-end`, { token: adminToken });
  check('POST auctions/:id/force-end', 'admin force-ends -> closed:true', r.status === 200 && r.json?.closed === true,
    `got ${r.status}: ${JSON.stringify(r.json)}`);

  r = await req('GET', `/auctions/${auction4}`);
  check('GET auctions/:id', 'no bids -> UNSOLD after close', r.status === 200 && r.json?.status === 'UNSOLD',
    `got ${r.status}: ${r.json?.status}`);

  // ================= Wallet =================
  r = await req('GET', '/wallet');
  check('GET wallet', 'no token -> 401', r.status === 401, `got ${r.status}`);

  r = await req('GET', '/wallet', { token: buyerToken });
  check('GET wallet', 'get-or-create -> 200, balance 0.00', r.status === 200 && r.json?.balance === '0.00',
    `got ${r.status}: ${JSON.stringify(r.json)}`);

  r = await req('GET', '/wallet/transactions', { token: buyerToken });
  check('GET wallet/transactions', 'empty list for fresh wallet', r.status === 200 && r.json?.items?.length === 0,
    `got ${r.status}: ${JSON.stringify(r.json)}`);

  r = await req('POST', '/wallet/topup', { token: buyerToken, body: { amount: 0 } });
  check('POST wallet/topup', 'amount 0 -> 400 (Zod)', r.status === 400, `got ${r.status}`);

  r = await req('POST', '/wallet/topup', { token: buyerToken, body: { amount: 25 } });
  check('POST wallet/topup', 'valid amount -> 201, real Stripe checkoutUrl', r.status === 201 && !!r.json?.checkoutUrl,
    `got ${r.status}: ${JSON.stringify(r.json)}`);

  r = await req('GET', '/wallet/topup/status?session_id=cs_test_bogus_session', { token: buyerToken });
  check('GET wallet/topup/status', 'unknown session_id -> 404', r.status === 404, `got ${r.status}`);

  r = await req('POST', '/wallet/withdraw', { token: buyerToken, body: { amount: 10 } });
  check('POST wallet/withdraw', 'no Connect account yet -> 400', r.status === 400, `got ${r.status}: ${r.json?.message}`);

  r = await req('GET', '/wallet/connect/status', { token: buyerToken });
  check('GET wallet/connect/status', 'not onboarded -> all false', r.status === 200 &&
    r.json?.detailsSubmitted === false && r.json?.payoutsEnabled === false, `got ${r.status}: ${JSON.stringify(r.json)}`);

  r = await req('POST', '/wallet/connect/onboard', { token: buyerToken });
  check('POST wallet/connect/onboard', 'real Stripe Connect account + onboarding url', r.status === 201 && !!r.json?.url,
    `got ${r.status}: ${JSON.stringify(r.json)}`);

  r = await req('POST', '/wallet/withdraw', { token: buyerToken, body: { amount: 10 } });
  check('POST wallet/withdraw', 'onboarded but payouts not enabled yet -> 400', r.status === 400, `got ${r.status}: ${r.json?.message}`);

  // ================= Admin scheduler =================
  r = await req('POST', '/scheduler/run', { token: buyerToken });
  check('POST scheduler/run', 'non-admin -> 403', r.status === 403, `got ${r.status}`);

  r = await req('POST', '/scheduler/run', { token: adminToken });
  check('POST scheduler/run', 'admin -> 200 with counters', r.status === 200 &&
    typeof r.json?.closed === 'number', `got ${r.status}: ${JSON.stringify(r.json)}`);

  // ---- summary ----
  const pass = results.filter((x) => x.ok).length;
  console.log(`\n=== ${pass}/${results.length} passed ===`);
  if (pass !== results.length) {
    console.log('FAILURES:');
    results.filter((x) => !x.ok).forEach((x) => console.log(`  ❌ [${x.endpoint}] ${x.name} — ${x.detail}`));
    process.exit(1);
  }
}
main().catch((e) => {
  console.error('runner error:', e);
  process.exit(2);
});
