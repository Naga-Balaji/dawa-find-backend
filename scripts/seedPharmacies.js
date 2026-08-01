require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Pharmacy = require('../models/Pharmacy');

function toNumber(v) {
  if (v === null || v === undefined) return NaN;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : NaN;
}

async function run() {
  await connectDB();
  const file = path.join(__dirname, '..', 'data', 'pharmacies.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));

  const docs = raw
    .map((p) => {
      const lat = toNumber(p.lat);
      const lon = toNumber(p.lon);
      if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
      return {
        name: p.name,
        address: p.address,
        landmark: p.landmark,
        phone: p.phone,
        rating: toNumber(p.rating) || undefined,
        ratingCount: toNumber(p.rating_count) || undefined,
        hours: p.hours,
        status: p.status,
        imageLink: (p.image_link || '').split(' ')[0], // first URL if srcset-style
        mapsLink: p.maps_link,
        docid: p.docid,
        location: { type: 'Point', coordinates: [lon, lat] },
        medicines: [],
      };
    })
    .filter(Boolean);

  await Pharmacy.deleteMany({});
  await Pharmacy.insertMany(docs, { ordered: false });
  console.log(`Seeded ${docs.length} pharmacies`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
