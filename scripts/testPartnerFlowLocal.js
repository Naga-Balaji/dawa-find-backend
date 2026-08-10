/* eslint-disable no-console */
// Runs the partner-flow walkthrough against a disposable in-memory MongoDB,
// so it never touches Atlas. Boots mongod, seeds pharmacies + medicines +
// an admin, starts the API, runs scripts/testPartnerFlow.js, tears down.
//
//   npm run test:partner:local
//
// To run against your real backend instead, start it yourself and use
// `npm run test:partner` (see PARTNER_FLOW.md).

const path = require('path');
const { spawn } = require('child_process');
const { MongoMemoryServer } = require('mongodb-memory-server');

const PORT = process.env.TEST_PORT || 5099;
const ADMIN_EMAIL = 'admin@dawafind.local';
const ADMIN_PASSWORD = 'admin12345';

function run(cmd, args, env, { quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      cwd: path.join(__dirname, '..'),
      env,
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    if (quiet) {
      p.stdout.on('data', () => {});
      p.stderr.on('data', (d) => process.stderr.write(d));
    }
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))));
    p.on('error', reject);
  });
}

async function waitForHealth(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  console.log('Booting disposable MongoDB…');
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri('dawafind_test');

  const env = {
    ...process.env,
    MONGO_URI: uri,
    PORT: String(PORT),
    JWT_SECRET: 'test_secret_not_for_production',
    JWT_EXPIRES_IN: '1h',
    CLIENT_ORIGIN: '*',
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    TEST_BASE_URL: `http://localhost:${PORT}/api/v1`,
  };

  // dotenv never overwrites variables already in process.env, so the MONGO_URI
  // passed to each child takes precedence over the real .env. Nothing to hide.
  let server;
  try {
    console.log('Seeding pharmacies, medicines, admin…');
    await run('node', ['scripts/seedPharmacies.js'], env, { quiet: true });
    await run('node', ['scripts/seedMedicines.js'], env, { quiet: true });
    await run('node', ['scripts/seedAdmin.js', ADMIN_EMAIL, ADMIN_PASSWORD], env, { quiet: true });
    await run('node', ['scripts/migrateInventoryStatus.js'], env, { quiet: true });

    console.log(`Starting API on :${PORT}…`);
    server = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env,
      stdio: ['ignore', 'ignore', 'inherit'],
    });

    const up = await waitForHealth(`http://localhost:${PORT}/api/health`);
    if (!up) throw new Error('API did not become healthy in time');

    await run('node', ['scripts/testPartnerFlow.js'], env);
  } finally {
    if (server) server.kill();
    await mongod.stop();
  }
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
