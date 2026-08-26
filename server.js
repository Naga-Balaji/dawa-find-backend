require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');

const app = express();

// CLIENT_ORIGIN can be a single URL or a comma-separated list
const origins = (process.env.CLIENT_ORIGIN || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(cors({ origin: origins.includes('*') ? '*' : origins, credentials: true }));
// Prescription scans arrive as base64 data URLs, which blow past the 100kb default.
app.use(express.json({ limit: '12mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use('/api/v1/auth', require('./routes/authRoutes'));
app.use('/api/v1/pharmacies', require('./routes/pharmacyRoutes'));
app.use('/api/v1/medicines', require('./routes/medicineRoutes'));
app.use('/api/v1/partner', require('./routes/partnerRoutes'));
app.use('/api/v1/admin', require('./routes/adminRoutes'));
app.use('/api/v1/ai', require('./routes/aiRoutes'));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: err.message || 'Server error' });
});

const PORT = process.env.PORT || 5000;

connectDB()
  .then(() => app.listen(PORT, () => console.log(`API on http://localhost:${PORT}`)))
  .catch((err) => {
    console.error('DB connection failed:', err.message);
    process.exit(1);
  });
