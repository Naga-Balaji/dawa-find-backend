const Pharmacy = require('../models/Pharmacy');
const Inventory = require('../models/Inventory');
const asyncHandler = require('../utils/asyncHandler');

// GET /api/v1/admin/pharmacies?status=pending
exports.listPharmacies = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.verificationStatus = req.query.status;
  if (req.query.source) filter.source = req.query.source;

  const items = await Pharmacy.find(filter)
    .populate('owner', 'name email phone')
    .sort({ createdAt: -1 })
    .limit(200);

  res.json({ count: items.length, items });
});

// PATCH /api/v1/admin/pharmacies/:id/verify
// Body: { decision: 'verified' | 'rejected', reason? }
exports.verifyPharmacy = asyncHandler(async (req, res) => {
  const decision = req.body.decision || 'verified';
  if (!['verified', 'rejected'].includes(decision))
    return res.status(400).json({ message: "decision must be 'verified' or 'rejected'" });

  const shop = await Pharmacy.findById(req.params.id);
  if (!shop) return res.status(404).json({ message: 'Pharmacy not found' });

  shop.verificationStatus = decision;
  shop.verifiedAt = new Date();
  shop.verifiedBy = req.user._id;
  shop.rejectionReason = decision === 'rejected' ? req.body.reason || 'Not specified' : undefined;
  await shop.save();

  res.json(shop);
});

// GET /api/v1/admin/metrics — pilot health at a glance
exports.metrics = asyncHandler(async (_req, res) => {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [byVerification, byStatus, freshRows, totalRows, activeShops] = await Promise.all([
    Pharmacy.aggregate([{ $group: { _id: '$verificationStatus', n: { $sum: 1 } } }]),
    Inventory.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    Inventory.countDocuments({ lastUpdatedAt: { $gte: dayAgo }, status: { $ne: 'unknown' } }),
    Inventory.countDocuments({}),
    Inventory.distinct('pharmacy', { lastUpdatedAt: { $gte: dayAgo } }),
  ]);

  const toMap = (rows) => rows.reduce((a, r) => ({ ...a, [r._id || 'none']: r.n }), {});

  res.json({
    pharmacies: toMap(byVerification),
    inventory: toMap(byStatus),
    freshness: {
      rowsUpdatedLast24h: freshRows,
      totalRows,
      percentFresh: totalRows ? Math.round((freshRows / totalRows) * 100) : 0,
      shopsActiveLast24h: activeShops.length,
    },
  });
});
