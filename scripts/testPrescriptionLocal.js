/* eslint-disable no-console */
// Exercises the AI prescription scan against a disposable in-memory MongoDB,
// with the OpenRouter call stubbed — so the extract -> match -> price pipeline
// is verified without spending free-tier quota or touching Atlas.
//
//   npm run test:prescription
//
// To check the real model reads a real photo, see the AI section of README.md.

const path = require('path');
const BACKEND = path.join(__dirname, '..');
process.chdir(BACKEND);

const { MongoMemoryServer } = require('mongodb-memory-server');

// Stub the model call before the controller requires the service.
// The controller destructures visionJson at require time, so the stub has to
// be a stable function that dispatches to a swappable impl.
const svc = require('../services/openrouter.js');
let impl;
svc.visionJson = async (...a) => impl(...a);
impl = async () => ({
  isPrescription: true,
  doctorName: 'R. Mehta',
  clinicName: 'Benz Circle Clinic',
  date: '2026-08-14',
  medicines: [
    { name: 'Paracetamol', brand: 'Calpol', strength: '500mg', form: 'tablet',
      dosage: '1-0-1 after food', duration: '5 days', quantity: '10', confidence: 'high' },
    { name: 'Amoxicillin Clavulanate', strength: '500mg', form: 'capsule',
      dosage: '1-0-1', duration: '7 days', confidence: 'medium' },
    { name: 'Zolpidoxifen', strength: '20mg', confidence: 'low' }, // deliberately unmatched
  ],
  notes: ['Drink plenty of water'],
});

let assertions = 0;
function check(label, cond) {
  assertions++;
  if (!cond) { console.error(`FAIL  ${label}`); process.exitCode = 1; }
  else console.log(`ok    ${label}`);
}

async function main() {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri('rxtest');
  process.env.JWT_SECRET = 'test_secret';
  process.env.JWT_EXPIRES_IN = '1h';
  process.env.OPENROUTER_API_KEY = 'stubbed';

  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGO_URI);

  const Medicine = require('../models/Medicine');
  const Pharmacy = require('../models/Pharmacy');
  const Inventory = require('../models/Inventory');
  const User = require('../models/User');

  await Medicine.insertMany(require('../data/medicines.json'));
  await Medicine.syncIndexes();

  // Two shops near Benz Circle at different prices.
  const shops = await Pharmacy.insertMany([
    { name: 'Sri Medicals', address: 'Benz Circle', phone: '+919000000001', docid: 'T1',
      location: { type: 'Point', coordinates: [80.6541, 16.5046] } },
    { name: 'Krishna Pharma', address: 'MG Road', phone: '+919000000002', docid: 'T2',
      location: { type: 'Point', coordinates: [80.6550, 16.5050] } },
  ]);
  await Pharmacy.syncIndexes();

  const para = await Medicine.findOne({ sku: 'MED-PARA-500' });
  const amox = await Medicine.findOne({ sku: 'MED-AMOX-500' });
  check('catalog seeded with paracetamol + amoxicillin', Boolean(para && amox));

  await Inventory.insertMany([
    { pharmacy: shops[0]._id, medicine: para._id, sku: para.sku, status: 'in_stock', stock: 40, price: 22 },
    { pharmacy: shops[1]._id, medicine: para._id, sku: para.sku, status: 'in_stock', stock: 10, price: 18 },
    { pharmacy: shops[0]._id, medicine: amox._id, sku: amox.sku, status: 'out_of_stock', stock: 0, price: 80 },
    { pharmacy: shops[1]._id, medicine: amox._id, sku: amox.sku, status: 'in_stock', stock: 5, price: 79 },
  ]);

  await User.create({ name: 'Test', email: 't@t.com', password: 'password123' });

  // Boot the app without server.js's listen/connect side effects.
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use((req, _res, next) => { req.user = { _id: 'testuser' }; next(); }); // bypass protect
  app.post('/rx', require('../controllers/aiController').readPrescription);
  app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ message: err.message }); });

  const server = app.listen(5098);
  const png = 'data:image/png;base64,' + Buffer.from('x'.repeat(600)).toString('base64');

  const res = await fetch('http://127.0.0.1:5098/rx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: png, lat: 16.5045, lon: 80.6540, radius: 5000 }),
  });
  const body = await res.json();
  check('200 OK', res.status === 200);

  const [p, a, z] = body.items || [];
  check('3 medicines returned', body.items?.length === 3);
  check('paracetamol matched to catalog', p?.catalog?.[0]?.sku === 'MED-PARA-500');
  check('paracetamol dosage preserved', p?.prescribed?.dosage === '1-0-1 after food');
  check('cheapest paracetamol price wins (18 not 22)', p?.bestPrice === 18);
  check('paracetamol in stock at 2 shops', p?.availableNearby === 2);
  check('offers sorted cheapest first', p?.offers?.[0]?.pharmacy?.name === 'Krishna Pharma');

  check('multi-word name falls back to first word', a?.catalog?.[0]?.sku === 'MED-AMOX-500');
  check('out-of-stock shop excluded from offers', a?.availableNearby === 1);
  check('amoxicillin priced from the in-stock shop', a?.bestPrice === 79);

  check('unknown drug returns no catalog match', z?.catalog?.length === 0);
  check('unknown drug still listed', z?.prescribed?.name === 'Zolpidoxifen');
  check('unmatched counted', body.unmatched === 1);
  check('estimated total = 18 + 79', body.estimatedTotal === 97);
  check('doctor name carried through', body.prescription?.doctorName === 'R. Mehta');
  check('notes carried through', body.prescription?.notes?.[0] === 'Drink plenty of water');
  check('disclaimer present', typeof body.disclaimer === 'string' && body.disclaimer.length > 20);

  // Validation paths
  const bad = await fetch('http://127.0.0.1:5098/rx', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: 'not-a-data-url' }),
  });
  check('rejects non-data-URL with 400', bad.status === 400);

  const gif = await fetch('http://127.0.0.1:5098/rx', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: 'data:image/gif;base64,AAAA' }),
  });
  check('rejects unsupported mime with 400', gif.status === 400);

  // Free models write "not specified"/"N/A" where the schema asks for null.
  impl = async () => ({
    isPrescription: true,
    doctorName: 'N/A',
    medicines: [
      { name: 'Paracetamol', brand: 'not specified', strength: '500mg',
        form: 'tablet', dosage: 'TDS', duration: '--', confidence: 'VERY SURE' },
      { name: 'unknown', brand: null },   // nothing identifiable — should be dropped
    ],
    notes: ['none'],
  });
  const ph = await fetch('http://127.0.0.1:5098/rx', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: png, lat: 16.5045, lon: 80.6540, radius: 5000 }),
  });
  const phBody = await ph.json();
  check('placeholder brand scrubbed to null', phBody.items[0].prescribed.brand === null);
  check('placeholder duration scrubbed to null', phBody.items[0].prescribed.duration === null);
  check('placeholder doctorName scrubbed to null', phBody.prescription.doctorName === null);
  check('placeholder note dropped', phBody.prescription.notes.length === 0);
  check('unidentifiable row dropped', phBody.items.length === 1);
  check('real fields survive scrubbing', phBody.items[0].prescribed.dosage === 'TDS');
  check('bogus confidence normalised', phBody.items[0].prescribed.confidence === 'medium');
  check('placeholder brand did not break matching', phBody.items[0].catalog[0].sku === 'MED-PARA-500');

  impl = async () => ({ isPrescription: false, notAPrescriptionReason: 'This is a cat.' });
  const cat = await fetch('http://127.0.0.1:5098/rx', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: png }),
  });
  check('non-prescription image returns 422', cat.status === 422);
  check('422 explains why', (await cat.json()).message === 'This is a cat.');

  server.close();
  await mongoose.disconnect();
  await mongod.stop();
  console.log(`\n${assertions} assertions, exit ${process.exitCode || 0}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
