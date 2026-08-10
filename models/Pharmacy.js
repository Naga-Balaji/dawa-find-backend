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
    // Scrape artefact: "Open" / "Closed" at scrape time. NOT the verification
    // state — see verificationStatus below.
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

    // ---- B2B partner fields ----
    // Where the record came from. 'scrape' rows are directory-only (map pins);
    // 'partner' rows were self-registered by a shop owner.
    source: {
      type: String,
      enum: ['scrape', 'partner', 'manual'],
      default: 'scrape',
      index: true,
    },
    // The pharmacy-role User who owns this shop. Null for unclaimed scrape rows.
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    licenceNo: { type: String, trim: true },
    verificationStatus: {
      type: String,
      enum: ['unverified', 'pending', 'verified', 'rejected'],
      default: 'unverified',
      index: true,
    },
    verifiedAt: Date,
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    rejectionReason: String,
  },
  { timestamps: true }
);

pharmacySchema.index({ location: '2dsphere' });

module.exports = mongoose.model('Pharmacy', pharmacySchema);
