const mongoose = require('mongoose');

const inventorySchema = new mongoose.Schema(
  {
    pharmacy: { type: mongoose.Schema.Types.ObjectId, ref: 'Pharmacy', required: true, index: true },
    medicine: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine', required: true, index: true },
    sku: { type: String, required: true, uppercase: true, index: true },
    stock: { type: Number, default: 0 },
    price: Number, // pharmacy-specific selling price (₹)
  },
  { timestamps: true }
);

inventorySchema.index({ pharmacy: 1, sku: 1 }, { unique: true });

module.exports = mongoose.model('Inventory', inventorySchema);
