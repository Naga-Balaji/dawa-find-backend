const Medicine = require('../models/Medicine');
const Inventory = require('../models/Inventory');
const Pharmacy = require('../models/Pharmacy');

// GET /api/v1/medicines  — list all catalog SKUs
exports.list = async (_req, res) => {
  const meds = await Medicine.find().sort({ name: 1 });
  res.json(meds);
};

// GET /api/v1/medicines/:sku
exports.getBySku = async (req, res) => {
  const med = await Medicine.findOne({ sku: req.params.sku.toUpperCase() });
  if (!med) return res.status(404).json({ message: 'Medicine not found' });
  res.json(med);
};

// GET /api/v1/medicines/:sku/pharmacies?lat=&lon=&radius=
// Which pharmacies (nearby, optional) stock this SKU
exports.pharmaciesForSku = async (req, res) => {
  const sku = req.params.sku.toUpperCase();
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const radius = parseInt(req.query.radius || '5000', 10);

  const inv = await Inventory.find({ sku, stock: { $gt: 0 } }).populate('pharmacy');
  let rows = inv.map((i) => ({
    pharmacy: i.pharmacy,
    stock: i.stock,
    price: i.price,
  }));

  if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
    const nearbyIds = await Pharmacy.find({
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: [lon, lat] },
          $maxDistance: radius,
        },
      },
    }).distinct('_id');
    const idSet = new Set(nearbyIds.map(String));
    rows = rows.filter((r) => r.pharmacy && idSet.has(String(r.pharmacy._id)));
  }

  res.json(rows);
};

// GET /api/v1/pharmacies/:id/inventory
exports.inventoryForPharmacy = async (req, res) => {
  const inv = await Inventory.find({ pharmacy: req.params.id }).populate('medicine');
  res.json(inv);
};
