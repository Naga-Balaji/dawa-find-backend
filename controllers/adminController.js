const Pharmacy = require('../models/Pharmacy');
const Inventory = require('../models/Inventory');
const asyncHandler = require('../utils/asyncHandler');

// GET /api/v1/admin/pharmacies?status=pending
exports.listPharmacies = asyncHandler(async (req, res) => {
  const filter = {};

  if (req.query.status) {
    filter.verificationStatus = req.query.status;
  }

  if (req.query.source) {
    filter.source = req.query.source;
  }

  const items = await Pharmacy.find(filter)
    .populate('owner', 'name email phone')
    .sort({ createdAt: -1 })
    .limit(200);

  res.json({
    count: items.length,
    items,
  });
});

// PATCH /api/v1/admin/pharmacies/:id/verify
// Body: { decision: 'verified' | 'rejected', reason? }
exports.verifyPharmacy = asyncHandler(async (req, res) => {
  const decision = req.body.decision || 'verified';

  if (!['verified', 'rejected'].includes(decision)) {
    return res.status(400).json({
      message: "decision must be 'verified' or 'rejected'",
    });
  }

  const shop = await Pharmacy.findById(req.params.id);

  if (!shop) {
    return res.status(404).json({
      message: 'Pharmacy not found',
    });
  }

  shop.verificationStatus = decision;
  shop.verifiedAt = new Date();
  shop.verifiedBy = req.user._id;

  if (decision === 'rejected') {
    shop.rejectionReason = req.body.reason || 'Not specified';
  } else {
    shop.rejectionReason = undefined;
  }

  await shop.save();

  res.json(shop);
});

// GET /api/v1/admin/metrics
// Admin dashboard statistics
exports.metrics = asyncHandler(async (_req, res) => {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    byVerification,
    byInventoryStatus,
    freshRows,
    totalInventoryRows,
    activeShops,
    totalPharmacies,
  ] = await Promise.all([
    // Pharmacy counts by verification status
    Pharmacy.aggregate([
      {
        $group: {
          _id: '$verificationStatus',
          n: { $sum: 1 },
        },
      },
    ]),

    // Inventory counts by status
    Inventory.aggregate([
      {
        $group: {
          _id: '$status',
          n: { $sum: 1 },
        },
      },
    ]),

    // Inventory rows updated during the last 24 hours
    Inventory.countDocuments({
      lastUpdatedAt: { $gte: dayAgo },
      status: { $ne: 'unknown' },
    }),

    // Total inventory rows
    Inventory.countDocuments({}),

    // Pharmacies that updated inventory during the last 24 hours
    Inventory.distinct('pharmacy', {
      lastUpdatedAt: { $gte: dayAgo },
    }),

    // Total pharmacies
    Pharmacy.countDocuments({}),
  ]);

  const toMap = (rows) =>
    rows.reduce(
      (result, row) => ({
        ...result,
        [row._id || 'none']: row.n,
      }),
      {}
    );

  const pharmacyStats = toMap(byVerification);
  const inventoryStats = toMap(byInventoryStatus);

  const pending = pharmacyStats.pending || 0;
  const unverified = pharmacyStats.unverified || 0;
  const verified = pharmacyStats.verified || 0;
  const rejected = pharmacyStats.rejected || 0;

  const needsAttention = pending + unverified;

  const verificationRate =
    totalPharmacies > 0
      ? Math.round((verified / totalPharmacies) * 100)
      : 0;

  const percentFresh =
    totalInventoryRows > 0
      ? Math.round((freshRows / totalInventoryRows) * 100)
      : 0;

  res.json({
    pharmacies: {
      total: totalPharmacies,
      pending,
      unverified,
      verified,
      rejected,
      needsAttention,
      verificationRate,
    },

    inventory: inventoryStats,

    freshness: {
      rowsUpdatedLast24h: freshRows,
      totalRows: totalInventoryRows,
      percentFresh,
      shopsActiveLast24h: activeShops.length,
    },
  });
});