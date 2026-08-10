/* eslint-disable no-console */
// Runs the API against a disposable in-memory MongoDB, pre-seeded with
// pharmacies, medicines and an admin account. Nothing touches Atlas.
//
//   npm run dev:sandbox        # then `npm run dev` in frontend/
//
// Data lives only for the life of this process — Ctrl-C wipes it.

const path = require('path');
const { spawn } = require('child_process');
const { MongoMemoryServer } = require('mongodb-memory-server');

const PORT = process.env.PORT || 5000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@dawafind.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin12345';
const ROOT = path.join(__dirname, '..');

function run(args, env) {
  return new Promise((resolve, reject) => {
    const p = spawn('node', args, { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'inherit'] });
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`${args.join(' ')} exited ${c}`))));
    p.on('error', reject);
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = require('net').createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port);
  });
}

async function main() {
  if (!(await portFree(PORT))) {
    console.error(
      `\nPort ${PORT} is already in use — you probably have \`npm run dev\` running.\n` +
        `Stop it, or run the sandbox on another port:\n\n` +
        `  PORT=5055 npm run dev:sandbox\n` +
        `  cd ../frontend && API_PROXY=http://localhost:5055 npm run dev\n`
    );
    process.exit(1);
  }

  console.log('Booting in-memory MongoDB…');
  const mongod = await MongoMemoryServer.create();

  const env = {
    ...process.env,
    MONGO_URI: mongod.getUri('dawafind_sandbox'),
    PORT: String(PORT),
    JWT_SECRET: 'sandbox_secret_not_for_production',
    JWT_EXPIRES_IN: '7d',
    CLIENT_ORIGIN: '*',
  };

  // No need to hide the real .env: dotenv never overwrites a variable that is
  // already present in process.env, so the MONGO_URI we pass to each child wins.
  let server;
  const shutdown = async () => {
    if (server) server.kill();
    await mongod.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    console.log('Seeding 99 pharmacies, medicine catalog, admin user…');
    await run(['scripts/seedPharmacies.js'], env);
    await run(['scripts/seedMedicines.js'], env);
    await run(['scripts/seedAdmin.js', ADMIN_EMAIL, ADMIN_PASSWORD], env);
    await run(['scripts/migrateInventoryStatus.js'], env);

    server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: 'inherit' });
    server.on('exit', shutdown);

    console.log(`
──────────────────────────────────────────────
  Sandbox API   http://localhost:${PORT}
  Admin login   ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}

  Now run the frontend:  cd ../frontend && npm run dev
  Data is in-memory — Ctrl-C wipes everything.
──────────────────────────────────────────────
`);
  } catch (err) {
    await mongod.stop().catch(() => {});
    throw err;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
