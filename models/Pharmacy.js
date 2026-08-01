const mongoose = require('mongoose');

const pharmacySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, index: 'text' },
    address: String,
    landmark: String,
    phone: String,
    rating: Number,
    ratingCount: Number,
    hours: String,
    status: String,
    imageLink: String,
    mapsLink: String,
    docid: { type: String, unique: true, sparse: true },
    // GeoJSON point: [longitude, latitude]
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true },
    },
    medicines: [{ type: String, index: true }],
  },
  { timestamps: true }
);

pharmacySchema.index({ location: '2dsphere' });

module.exports = mongoose.model('Pharmacy', pharmacySchema);
