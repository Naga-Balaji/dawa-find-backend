const mongoose = require('mongoose');

const STATUSES = ['in_stock', 'out_of_stock', 'unknown'];

const inventorySchema = new mongoose.Schema(
  {
    pharmacy: { type: mongoose.Schema.Types.ObjectId, ref: 'Pharmacy', required: true, index: true },
    medicine: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine', required: true, index: true },
    sku: { type: String, required: true, uppercase: true, index: true },

    // Availability is tri-state: a shop that has never touched a SKU is
    // 'unknown', which is different from 'out_of_stock'. A 48h cron can decay
    // stale rows back to 'unknown' using lastUpdatedAt.
    status: { type: String, enum: STATUSES, default: 'unknown', index: true },
    // Optional count. Kept alongside status because some shops do track units;
    // when a writer sends stock but no status, status is derived from it.
    stock: { type: Number, default: 0 },
    price: Number, // pharmacy-specific selling price (₹)

    updatedBy: { type: String, enum: ['pharmacy', 'admin', 'system', 'seed'], default: 'seed' },
    lastUpdatedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

inventorySchema.index({ pharmacy: 1, sku: 1 }, { unique: true });
// Serves the core search: "who near me has this SKU in stock".
inventorySchema.index({ sku: 1, status: 1, pharmacy: 1 });

inventorySchema.statics.STATUSES = STATUSES;

// Given a partial write, work out the (status, stock) pair to persist.
// Explicit status always wins; otherwise a supplied count decides.
inventorySchema.statics.resolveAvailability = function (input = {}, current = {}) {
  const hasStatus = STATUSES.includes(input.status);
  const hasStock = input.stock !== undefined && input.stock !== null && input.stock !== '';

  let stock = hasStock ? Math.max(0, Number(input.stock) || 0) : current.stock ?? 0;
  let status;

  if (hasStatus) {
    status = input.status;
    // Keep the count from contradicting an explicit status.
    if (status === 'out_of_stock') stock = 0;
    if (status === 'in_stock' && !hasStock && stock === 0) stock = 0; // count simply unknown
  } else if (hasStock) {
    status = stock > 0 ? 'in_stock' : 'out_of_stock';
  } else {
    status = current.status ?? 'unknown';
  }

  return { status, stock };
};

module.exports = mongoose.model('Inventory', inventorySchema);
