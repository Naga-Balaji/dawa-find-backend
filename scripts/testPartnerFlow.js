/* eslint-disable no-console */
require('dotenv').config();

// End-to-end walkthrough of the B2B partner flow against a running backend.
//   Terminal 1: npm run dev
//   Terminal 2: npm run test:partner
//
// Drives the same HTTP calls documented in PARTNER_FLOW.md and asserts each
// step, including the negative cases (unverified shop cannot publish stock,
// customer role cannot reach partner routes).

const BASE = process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 5000}/api/v1`;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@dawafind.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin12345';

const stamp = Date.now();
const partner = {
  name: 'Sri Sai Medicals (test)',
  email: `partner+${stamp}@dawafind.test`,
  password: 'partner12345',
  phone: '+91 9000000001',
};
const customer = { name: 'Test Customer', email: `cust+${stamp}@dawafind.test`, password: 'cust12345' };

// Benz Circle, Vijayawada — inside the seeded pharmacy cluster.
const SHOP_LOCATION = { lat: 16.5045, lon: 80.654 };

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  [32m✓[0m ${label}`);
  } else {
    failed += 1;
    console.log(`  [31m✗ ${label}[0m`);
    if (detail !== undefined) console.log(`    ${JSON.stringify(detail)}`);
  }
}

function step(n, title) {
  console.log(`\n[1m${n}. ${title}[0m`);
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

async function run() {
  console.log(`Dawa-Find · partner flow test\nTarget: ${BASE}`);

  const health = await fetch(`${BASE.replace('/api/v1', '')}/api/health`).catch(() => null);
  if (!health || !health.ok) {
    console.error(`\nBackend not reachable at ${BASE}. Start it with: npm run dev`);
    process.exit(1);
  }

  // ---------------------------------------------------------------
  step(1, 'Partner signs up with role=pharmacy');
  const reg = await call('POST', '/auth/register', { body: { ...partner, role: 'pharmacy' } });
  check('201 Created', reg.status === 201, reg.data);
  check("role is 'pharmacy'", reg.data?.user?.role === 'pharmacy', reg.data?.user);
  check('no shop attached yet', reg.data?.user?.pharmacy === null, reg.data?.user);
  const partnerToken = reg.data?.token;
  if (!partnerToken) return finish();

  // ---------------------------------------------------------------
  step(2, 'Partner has no shop yet — inventory board is 404 NO_SHOP');
  const noShop = await call('GET', '/partner/inventory', { token: partnerToken });
  check('404 with code NO_SHOP', noShop.status === 404 && noShop.data?.code === 'NO_SHOP', noShop.data);

  // ---------------------------------------------------------------
  step(3, 'Partner registers the shop');
  const shopRes = await call('POST', '/partner/shop', {
    token: partnerToken,
    body: {
      name: partner.name,
      address: 'Door 4-21, MG Road, Benz Circle, Vijayawada - 520010',
      phone: partner.phone,
      hours: 'Mon - Sun :- 8:00 am - 11:00 pm',
      licenceNo: `AP/20B/${stamp}`,
      ...SHOP_LOCATION,
    },
  });
  check('201 Created', shopRes.status === 201, shopRes.data);
  check("verificationStatus is 'pending'", shopRes.data?.pharmacy?.verificationStatus === 'pending', shopRes.data?.pharmacy);
  check("source is 'partner'", shopRes.data?.pharmacy?.source === 'partner', shopRes.data?.pharmacy);
  check('duplicate check ran', Array.isArray(shopRes.data?.possibleDuplicates), shopRes.data);
  const shopId = shopRes.data?.pharmacy?._id;
  if (shopRes.data?.possibleDuplicates?.length)
    console.log(`    note: ${shopRes.data.possibleDuplicates.length} nearby same-name listing(s) — merge candidates`);

  step(3.1, 'Second registration is rejected');
  const dupe = await call('POST', '/partner/shop', {
    token: partnerToken,
    body: { name: 'x', address: 'x', phone: 'x', licenceNo: 'x', ...SHOP_LOCATION },
  });
  check('409 Conflict', dupe.status === 409, dupe.data);

  // ---------------------------------------------------------------
  step(4, 'Unverified shop cannot publish stock');
  const blocked = await call('PUT', '/partner/inventory', {
    token: partnerToken,
    body: { items: [{ sku: 'MED-PARA-500', status: 'in_stock' }] },
  });
  check('403 with code NOT_VERIFIED', blocked.status === 403 && blocked.data?.code === 'NOT_VERIFIED', blocked.data);

  step(4.1, 'But the board is readable while pending');
  const boardPending = await call('GET', '/partner/inventory', { token: partnerToken });
  check('200 OK', boardPending.status === 200, boardPending.data);
  check('every catalog SKU listed', boardPending.data?.total > 0, boardPending.data?.total);
  check(
    'all start as unknown',
    boardPending.data?.summary?.unknown === boardPending.data?.total,
    boardPending.data?.summary
  );
  const catalog = boardPending.data?.items || [];

  // ---------------------------------------------------------------
  step(5, 'A customer account cannot touch partner routes');
  const custReg = await call('POST', '/auth/register', { body: customer });
  check('customer registered', custReg.status === 201, custReg.data);
  const forbidden = await call('GET', '/partner/inventory', { token: custReg.data?.token });
  check('403 Forbidden for role=user', forbidden.status === 403, forbidden.data);

  // ---------------------------------------------------------------
  step(6, 'Admin verifies the licence');
  const adminLogin = await call('POST', '/auth/login', {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (adminLogin.status !== 200) {
    check('admin login', false, `Run: node scripts/seedAdmin.js ${ADMIN_EMAIL} ${ADMIN_PASSWORD}`);
    return finish();
  }
  check('admin logged in', adminLogin.data?.user?.role === 'admin', adminLogin.data?.user);
  const adminToken = adminLogin.data.token;

  const pending = await call('GET', '/admin/pharmacies?status=pending', { token: adminToken });
  check('shop appears in pending queue', pending.data?.items?.some((p) => p._id === shopId), pending.data?.count);

  const verify = await call('PATCH', `/admin/pharmacies/${shopId}/verify`, {
    token: adminToken,
    body: { decision: 'verified' },
  });
  check("verificationStatus is now 'verified'", verify.data?.verificationStatus === 'verified', verify.data);

  // ---------------------------------------------------------------
  step(7, 'Partner publishes stock (bulk)');
  const target = catalog.slice(0, 3);
  if (target.length < 3) {
    check('catalog has >= 3 SKUs', false, `only ${target.length}. Run: npm run seed:medicines`);
    return finish();
  }
  const bulk = await call('PUT', '/partner/inventory', {
    token: partnerToken,
    body: {
      items: [
        { sku: target[0].sku, status: 'in_stock', price: 24 },
        { sku: target[1].sku, stock: 12 }, // status derived from count
        { sku: target[2].sku, status: 'out_of_stock' },
        { sku: 'MED-DOES-NOT-EXIST', status: 'in_stock' }, // rejected
      ],
    },
  });
  check('200 OK', bulk.status === 200, bulk.data);
  check('3 rows written', (bulk.data?.created || 0) + (bulk.data?.updated || 0) === 3, bulk.data);
  check('unknown SKU rejected, not silently dropped', bulk.data?.rejected?.length === 1, bulk.data?.rejected);

  const board = await call('GET', '/partner/inventory', { token: partnerToken });
  const row = (sku) => board.data.items.find((i) => i.sku === sku);
  check('explicit in_stock persisted', row(target[0].sku)?.status === 'in_stock', row(target[0].sku));
  check('price override persisted', row(target[0].sku)?.price === 24, row(target[0].sku));
  check('stock:12 derived to in_stock', row(target[1].sku)?.status === 'in_stock', row(target[1].sku));
  check('count kept alongside status', row(target[1].sku)?.stock === 12, row(target[1].sku));
  check('out_of_stock zeroes the count', row(target[2].sku)?.stock === 0, row(target[2].sku));
  check('summary counts 2 in / 1 out', board.data?.summary?.in_stock === 2 && board.data?.summary?.out_of_stock === 1, board.data?.summary);

  // ---------------------------------------------------------------
  step(8, 'Single-SKU toggle');
  const toggle = await call('PATCH', `/partner/inventory/${target[0].sku}`, {
    token: partnerToken,
    body: { status: 'out_of_stock' },
  });
  check('200 OK', toggle.status === 200, toggle.data);
  check("flipped to out_of_stock", toggle.data?.status === 'out_of_stock', toggle.data);
  check("updatedBy is 'pharmacy'", toggle.data?.updatedBy === 'pharmacy', toggle.data);

  const badStatus = await call('PATCH', `/partner/inventory/${target[0].sku}`, {
    token: partnerToken,
    body: { status: 'maybe' },
  });
  check('invalid status rejected with 400', badStatus.status === 400, badStatus.data);

  // ---------------------------------------------------------------
  step(9, 'Customer search sees only what is in stock');
  const search = await call(
    'GET',
    `/pharmacies/medicines/nearby?name=${encodeURIComponent(target[1].name)}&lat=${SHOP_LOCATION.lat}&lon=${SHOP_LOCATION.lon}&radius=2000`
  );
  check('200 OK', search.status === 200, search.data);
  const hit = (search.data || []).find((r) => r.pharmacy?._id === shopId);
  check('partner shop is returned for the in-stock SKU', !!hit, search.data?.length);
  check('row carries freshness timestamp', !!hit?.lastUpdatedAt, hit);

  const searchOut = await call(
    'GET',
    `/pharmacies/medicines/nearby?name=${encodeURIComponent(target[2].name)}&lat=${SHOP_LOCATION.lat}&lon=${SHOP_LOCATION.lon}&radius=2000`
  );
  const outHit = (searchOut.data || []).find((r) => r.pharmacy?._id === shopId);
  check('out_of_stock SKU does NOT surface the shop', !outHit, searchOut.data?.length);

  // ---------------------------------------------------------------
  step(10, '"Still correct" refreshes freshness without changing status');
  const before = row(target[1].sku)?.lastUpdatedAt;
  await new Promise((r) => setTimeout(r, 1100));
  const confirm = await call('POST', '/partner/inventory/confirm', { token: partnerToken });
  check('200 OK', confirm.status === 200, confirm.data);
  check('rows confirmed', confirm.data?.confirmed >= 3, confirm.data);

  const after = await call('GET', '/partner/inventory', { token: partnerToken });
  const afterRow = after.data.items.find((i) => i.sku === target[1].sku);
  check('lastUpdatedAt moved forward', new Date(afterRow.lastUpdatedAt) > new Date(before), {
    before,
    after: afterRow.lastUpdatedAt,
  });
  check('status unchanged', afterRow.status === 'in_stock', afterRow);
  check(
    'untouched SKUs stay unknown',
    after.data.summary.unknown === after.data.total - 3,
    after.data.summary
  );

  // ---------------------------------------------------------------
  step(11, 'Admin metrics reflect the activity');
  const metrics = await call('GET', '/admin/metrics', { token: adminToken });
  check('200 OK', metrics.status === 200, metrics.data);
  check('at least one verified pharmacy', (metrics.data?.pharmacies?.verified || 0) >= 1, metrics.data?.pharmacies);
  check('shop counted as active in last 24h', (metrics.data?.freshness?.shopsActiveLast24h || 0) >= 1, metrics.data?.freshness);

  finish();
}

function finish() {
  console.log(`\n${'─'.repeat(52)}`);
  const colour = failed ? '[31m' : '[32m';
  console.log(`${colour}${passed} passed, ${failed} failed[0m`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
