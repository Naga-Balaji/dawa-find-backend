require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Inventory = require('../models/Inventory');
const Pharmacy = require('../models/Pharmacy');

// One-off: backfill tri-state fields onto inventory rows written before the
// status/lastUpdatedAt columns existed, and stamp source on scraped shops.
async function run() {
  await connectDB();

  const inStock = await Inventory.updateMany(
    { status: { $exists: false }, stock: { $gt: 0 } },
    { $set: { status: 'in_stock', updatedBy: 'seed', lastUpdatedAt: new Date() } }
  );
  const outOfStock = await Inventory.updateMany(
    { status: { $exists: false }, $or: [{ stock: { $lte: 0 } }, { stock: { $exists: false } }] },
    { $set: { status: 'out_of_stock', stock: 0, updatedBy: 'seed', lastUpdatedAt: new Date() } }
  );

  const shops = await Pharmacy.updateMany(
    { source: { $exists: false } },
    { $set: { source: 'scrape', verificationStatus: 'unverified', owner: null } }
  );

  console.log(`inventory → in_stock:     ${inStock.modifiedCount}`);
  console.log(`inventory → out_of_stock: ${outOfStock.modifiedCount}`);
  console.log(`pharmacies → source=scrape: ${shops.modifiedCount}`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
