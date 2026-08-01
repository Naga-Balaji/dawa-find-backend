require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Medicine = require('../models/Medicine');
const Pharmacy = require('../models/Pharmacy');
const Inventory = require('../models/Inventory');

async function run() {
  await connectDB();

  // 1. Seed medicines
  const file = path.join(__dirname, '..', 'data', 'medicines.json');
  const meds = JSON.parse(fs.readFileSync(file, 'utf-8'));
  await Medicine.deleteMany({});
  const insertedMeds = await Medicine.insertMany(meds);
  console.log(`Seeded ${insertedMeds.length} medicines`);

  // 2. Pick the first two pharmacies to map inventory to
  const pharmacies = await Pharmacy.find().limit(2);
  if (pharmacies.length < 2) {
    console.error('Need at least 2 pharmacies in DB. Run `npm run seed` first.');
    await mongoose.disconnect();
    process.exit(1);
  }
  const [shopA, shopB] = pharmacies;

  // 3. Map: shopA stocks first 6 SKUs, shopB stocks last 6 (overlap in middle)
  await Inventory.deleteMany({});
  const inventoryDocs = [];
  insertedMeds.slice(0, 6).forEach((m) => {
    inventoryDocs.push({
      pharmacy: shopA._id,
      medicine: m._id,
      sku: m.sku,
      stock: Math.floor(Math.random() * 50) + 10,
      price: m.price,
    });
  });
  insertedMeds.slice(4).forEach((m) => {
    inventoryDocs.push({
      pharmacy: shopB._id,
      medicine: m._id,
      sku: m.sku,
      stock: Math.floor(Math.random() * 50) + 10,
      price: m.price + 5, // shop B slightly pricier
    });
  });
  await Inventory.insertMany(inventoryDocs);
  console.log(`Linked ${inventoryDocs.length} inventory rows`);
  console.log(`  ${shopA.name} → 6 SKUs`);
  console.log(`  ${shopB.name} → 6 SKUs`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
