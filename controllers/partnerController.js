const mongoose = require('mongoose');
const Pharmacy = require('../models/Pharmacy');
const Medicine = require('../models/Medicine');
const Inventory = require('../models/Inventory');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');

// Metres within which a same-named shop is treated as a likely duplicate of an
// already-scraped listing. Reported, never blocking — the owner knows their shop.
const DUPLICATE_RADIUS_M = 250;

function normalise(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Loads the caller's shop, or answers 4xx and returns null.
async function requireOwnShop(req, res, { mustBeVerified = false } = {}) {
  if (!req.user.pharmacy) {
    res.status(404).json({
      message: 'No shop registered yet. POST /api/v1/partner/shop first.',
      code: 'NO_SHOP',
    });
    return null;
  }
  const shop = await Pharmacy.findById(req.user.pharmacy);
  if (!shop) {
    res.status(404).json({ message: 'Shop record missing', code: 'NO_SHOP' });
    return null;
  }
  if (mustBeVerified && shop.verificationStatus !== 'verified') {
    res.status(403).json({
      message: `Shop is '${shop.verificationStatus}'. An admin must verify your licence before you can publish stock.`,
      code: 'NOT_VERIFIED',
      verificationStatus: shop.verificationStatus,
    });
    return null;
  }
  return shop;
}

// POST /api/v1/partner/shop  — register the caller's shop
exports.registerShop = asyncHandler(async (req, res) => {
  if (req.user.pharmacy)
    return res.status(409).json({
      message: 'You already have a registered shop',
      pharmacyId: req.user.pharmacy,
    });

  const { name, address, landmark, phone, hours, licenceNo, lat, lon } = req.body;
  const latitude = parseFloat(lat);
  const longitude = parseFloat(lon);

  const missing = [];
  if (!name) missing.push('name');
  if (!address) missing.push('address');
  if (!phone) missing.push('phone');
  if (!licenceNo) missing.push('licenceNo');
  if (Number.isNaN(latitude)) missing.push('lat');
  if (Number.isNaN(longitude)) missing.push('lon');
  if (missing.length)
    return res.status(400).json({ message: `Missing required fields: ${missing.join(', ')}` });

  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180)
    return res.status(400).json({ message: 'lat/lon out of range' });

  const existingLicence = await Pharmacy.findOne({ licenceNo: licenceNo.trim() });
  if (existingLicence)
    return res.status(409).json({ message: 'That licence number is already registered' });

  const shop = await Pharmacy.create({
    name,
    address,
    landmark,
    phone,
    hours,
    licenceNo: licenceNo.trim(),
    location: { type: 'Point', coordinates: [longitude, latitude] },
    source: 'partner',
    owner: req.user._id,
    verificationStatus: 'pending',
    mapsLink: `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`,
  });

  await User.findByIdAndUpdate(req.user._id, { pharmacy: shop._id });

  // Advisory only: the directory already holds ~99 scraped listings, so a
  // partner registration can shadow one. Surfaced so it can be merged later.
  const near = await Pharmacy.find({
    _id: { $ne: shop._id },
    location: {
      $near: {
        $geometry: { type: 'Point', coordinates: [longitude, latitude] },
        $maxDistance: DUPLICATE_RADIUS_M,
      },
    },
  }).limit(10).select('name address source location');

  const target = normalise(name);
  const possibleDuplicates = near.filter((p) => {
    const other = normalise(p.name);
    return other.includes(target) || target.includes(other);
  });

  res.status(201).json({
    pharmacy: shop,
    possibleDuplicates,
    next: 'Awaiting admin verification — PATCH /api/v1/admin/pharmacies/:id/verify',
  });
});

// GET /api/v1/partner/shop  — my shop profile + verification state
exports.getShop = asyncHandler(async (req, res) => {
  const shop = await requireOwnShop(req, res);
  if (!shop) return;
  res.json(shop);
});

// PATCH /api/v1/partner/shop  — edit my shop profile
exports.updateShop = asyncHandler(async (req, res) => {
  const shop = await requireOwnShop(req, res);
  if (!shop) return;

  const editable = ['name', 'address', 'landmark', 'phone', 'hours', 'imageLink'];
  editable.forEach((f) => {
    if (req.body[f] !== undefined) shop[f] = req.body[f];
  });

  if (req.body.lat !== undefined && req.body.lon !== undefined) {
    const latitude = parseFloat(req.body.lat);
    const longitude = parseFloat(req.body.lon);
    if (Number.isNaN(latitude) || Number.isNaN(longitude))
      return res.status(400).json({ message: 'lat/lon must be numbers' });
    shop.location = { type: 'Point', coordinates: [longitude, latitude] };
  }

  // Changing the licence re-opens verification — an admin must look again.
  if (req.body.licenceNo && req.body.licenceNo.trim() !== shop.licenceNo) {
    const clash = await Pharmacy.findOne({
      licenceNo: req.body.licenceNo.trim(),
      _id: { $ne: shop._id },
    });
    if (clash) return res.status(409).json({ message: 'That licence number is already registered' });
    shop.licenceNo = req.body.licenceNo.trim();
    shop.verificationStatus = 'pending';
    shop.verifiedAt = undefined;
    shop.verifiedBy = null;
  }

  await shop.save();
  res.json(shop);
});

// GET /api/v1/partner/inventory  — the stock board
// Returns every catalog SKU joined with this shop's row, so the dashboard can
// render all toggles including SKUs never touched (status 'unknown').
exports.getInventory = asyncHandler(async (req, res) => {
  const shop = await requireOwnShop(req, res);
  if (!shop) return;

  const [medicines, rows] = await Promise.all([
    Medicine.find().sort({ name: 1 }).lean(),
    Inventory.find({ pharmacy: shop._id }).lean(),
  ]);

  const bySku = new Map(rows.map((r) => [r.sku, r]));
  const items = medicines.map((m) => {
    const row = bySku.get(m.sku);
    return {
      medicineId: m._id,
      sku: m.sku,
      name: m.name,
      brand: m.brand,
      form: m.form,
      strength: m.strength,
      mrp: m.price,
      prescriptionRequired: m.prescriptionRequired,
      status: row?.status || 'unknown',
      stock: row?.stock ?? 0,
      price: row?.price ?? m.price,
      lastUpdatedAt: row?.lastUpdatedAt || null,
      updatedBy: row?.updatedBy || null,
    };
  });

  const summary = items.reduce(
    (acc, i) => ({ ...acc, [i.status]: (acc[i.status] || 0) + 1 }),
    { in_stock: 0, out_of_stock: 0, unknown: 0 }
  );

  res.json({
    pharmacy: {
      id: shop._id,
      name: shop.name,
      verificationStatus: shop.verificationStatus,
    },
    summary,
    total: items.length,
    items,
  });
});

// PUT /api/v1/partner/inventory  — bulk upsert
// Body: { items: [{ sku, status?, stock?, price? }, ...] }
exports.bulkUpdateInventory = asyncHandler(async (req, res) => {
  const shop = await requireOwnShop(req, res, { mustBeVerified: true });
  if (!shop) return;

  const input = Array.isArray(req.body.items) ? req.body.items : null;
  if (!input || !input.length)
    return res.status(400).json({ message: 'items must be a non-empty array' });
  if (input.length > 500)
    return res.status(400).json({ message: 'Max 500 items per request' });

  const skus = [...new Set(input.map((i) => String(i.sku || '').toUpperCase()).filter(Boolean))];
  if (!skus.length) return res.status(400).json({ message: 'No valid sku values supplied' });

  const meds = await Medicine.find({ sku: { $in: skus } }).select('_id sku price').lean();
  const medBySku = new Map(meds.map((m) => [m.sku, m]));

  const current = await Inventory.find({ pharmacy: shop._id, sku: { $in: skus } }).lean();
  const currentBySku = new Map(current.map((r) => [r.sku, r]));

  const now = new Date();
  const ops = [];
  const unknownSkus = [];

  input.forEach((item) => {
    const sku = String(item.sku || '').toUpperCase();
    const med = medBySku.get(sku);
    if (!med) {
      if (sku) unknownSkus.push(sku);
      return;
    }
    if (item.status !== undefined && !Inventory.STATUSES.includes(item.status)) {
      unknownSkus.push(`${sku} (bad status '${item.status}')`);
      return;
    }

    const { status, stock } = Inventory.resolveAvailability(item, currentBySku.get(sku) || {});
    const price =
      item.price !== undefined && item.price !== null && item.price !== ''
        ? Math.max(0, Number(item.price) || 0)
        : currentBySku.get(sku)?.price ?? med.price;

    ops.push({
      updateOne: {
        filter: { pharmacy: shop._id, sku },
        update: {
          $set: {
            medicine: med._id,
            status,
            stock,
            price,
            updatedBy: 'pharmacy',
            lastUpdatedAt: now,
          },
          $setOnInsert: { pharmacy: shop._id, sku },
        },
        upsert: true,
      },
    });
  });

  if (!ops.length)
    return res.status(400).json({
      message: 'No items matched the medicine catalog',
      rejected: unknownSkus,
    });

  const result = await Inventory.bulkWrite(ops, { ordered: false });

  res.json({
    updated: result.modifiedCount || 0,
    created: result.upsertedCount || 0,
    matched: result.matchedCount || 0,
    rejected: unknownSkus,
    lastUpdatedAt: now,
  });
});

// PATCH /api/v1/partner/inventory/:sku  — single toggle
exports.updateOneSku = asyncHandler(async (req, res) => {
  const shop = await requireOwnShop(req, res, { mustBeVerified: true });
  if (!shop) return;

  const sku = String(req.params.sku || '').toUpperCase();
  const med = await Medicine.findOne({ sku }).select('_id sku price').lean();
  if (!med) return res.status(404).json({ message: `SKU ${sku} is not in the catalog` });

  if (req.body.status !== undefined && !Inventory.STATUSES.includes(req.body.status))
    return res.status(400).json({
      message: `status must be one of: ${Inventory.STATUSES.join(', ')}`,
    });

  const existing = await Inventory.findOne({ pharmacy: shop._id, sku }).lean();
  const { status, stock } = Inventory.resolveAvailability(req.body, existing || {});
  const price =
    req.body.price !== undefined && req.body.price !== null && req.body.price !== ''
      ? Math.max(0, Number(req.body.price) || 0)
      : existing?.price ?? med.price;

  const row = await Inventory.findOneAndUpdate(
    { pharmacy: shop._id, sku },
    {
      $set: {
        medicine: med._id,
        status,
        stock,
        price,
        updatedBy: 'pharmacy',
        lastUpdatedAt: new Date(),
      },
      $setOnInsert: { pharmacy: shop._id, sku },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).populate('medicine');

  res.json(row);
});

// POST /api/v1/partner/inventory/confirm  — "everything above is still correct"
// Refreshes lastUpdatedAt without changing any status, so the 48h decay job
// does not drop a shop that simply had no changes today.
exports.confirmAll = asyncHandler(async (req, res) => {
  const shop = await requireOwnShop(req, res, { mustBeVerified: true });
  if (!shop) return;

  const now = new Date();
  const result = await Inventory.updateMany(
    { pharmacy: shop._id, status: { $ne: 'unknown' } },
    { $set: { lastUpdatedAt: now, updatedBy: 'pharmacy' } }
  );

  res.json({ confirmed: result.modifiedCount, lastUpdatedAt: now });
});
