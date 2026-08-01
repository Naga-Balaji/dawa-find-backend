const mongoose = require('mongoose');

const medicineSchema = new mongoose.Schema(
  {
    sku: { type: String, required: true, unique: true, uppercase: true, trim: true },
    name: { type: String, required: true, index: true },
    brand: String,
    form: String,        // tablet / syrup / capsule / injection ...
    strength: String,    // 500mg, 10ml, etc.
    price: Number,       // MRP (₹)
    description: String,
    prescriptionRequired: { type: Boolean, default: false },
  },
  { timestamps: true }
);

medicineSchema.index({ name: 'text', brand: 'text' });

module.exports = mongoose.model('Medicine', medicineSchema);
