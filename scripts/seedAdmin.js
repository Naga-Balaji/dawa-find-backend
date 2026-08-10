require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const User = require('../models/User');

// Admins are never created over the wire — only here.
// Usage: node scripts/seedAdmin.js [email] [password]
async function run() {
  await connectDB();

  const email = (process.argv[2] || process.env.ADMIN_EMAIL || 'admin@dawafind.local').toLowerCase();
  const password = process.argv[3] || process.env.ADMIN_PASSWORD;

  if (!password) {
    console.error('Password required: node scripts/seedAdmin.js <email> <password>');
    await mongoose.disconnect();
    process.exit(1);
  }

  const existing = await User.findOne({ email });
  if (existing) {
    existing.role = 'admin';
    existing.password = password; // pre-save hook re-hashes
    await existing.save();
    console.log(`Updated existing user → admin: ${email}`);
  } else {
    await User.create({ name: 'Dawa-Find Admin', email, password, role: 'admin' });
    console.log(`Created admin: ${email}`);
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
