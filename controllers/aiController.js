const Medicine = require('../models/Medicine');
const Inventory = require('../models/Inventory');
const Pharmacy = require('../models/Pharmacy');
const asyncHandler = require('../utils/asyncHandler');
const { visionJson, OpenRouterError } = require('../services/openrouter');

// Same availability rule the pharmacy search uses — legacy rows predate
// tri-state status and only carry a count.
const AVAILABLE = { $or: [{ status: 'in_stock' }, { status: { $exists: false }, stock: { $gt: 0 } }] };

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // ~8 MB decoded
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Each call costs OpenRouter credit, so cap per-user volume. In-memory is
// fine for a single dyno; move to Redis if the API ever runs multi-instance.
const RATE_LIMIT = { max: 20, windowMs: 60 * 60 * 1000 };
const hits = new Map();

function rateLimited(userId) {
  const now = Date.now();
  const fresh = (hits.get(userId) || []).filter((t) => now - t < RATE_LIMIT.windowMs);
  if (fresh.length >= RATE_LIMIT.max) return true;
  fresh.push(now);
  hits.set(userId, fresh);
  return false;
}

const SYSTEM = `You are a pharmacy assistant that reads photographs of medical prescriptions.
You transcribe what is written. You never invent a drug that is not on the page, never
suggest a substitute, and never give medical advice or dosing opinions of your own.
Handwriting is often unclear: when you are unsure of a word, say so via the confidence
field rather than guessing confidently. Reply with JSON only — no prose, no code fences.`;

const PROMPT = `Read this prescription image and return JSON with exactly this shape:

{
  "isPrescription": boolean,
  "notAPrescriptionReason": string | null,
  "doctorName": string | null,
  "clinicName": string | null,
  "patientName": string | null,
  "date": string | null,
  "medicines": [
    {
      "name": "generic or salt name as best you can read it",
      "brand": "brand name if printed, else null",
      "strength": "e.g. 500mg, 10ml, else null",
      "form": "tablet | capsule | syrup | injection | cream | drops | other | null",
      "dosage": "how it is to be taken, e.g. 1-0-1 after food, else null",
      "duration": "e.g. 5 days, else null",
      "quantity": "total units written, else null",
      "confidence": "high | medium | low"
    }
  ],
  "notes": [ "any other instruction written on the page" ]
}

Rules:
- If the image is not a prescription, set isPrescription to false, explain briefly in
  notAPrescriptionReason, and return an empty medicines array.
- Transcribe every drug line you can see, even if partially legible. Mark those "low".
- Do not add medicines that are not written on the page.
- Dosage-form abbreviations are not brand names. "Tab.", "Cap.", "Syp.", "Inj.",
  "Oint." and similar belong in "form" — leave "brand" null unless an actual
  brand name is printed.
- Return JSON only.`;

// Regex-escape LLM-supplied text before it reaches a Mongo $regex.
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Free models routinely write "not specified" or "N/A" where the schema asks
// for null. Left alone those become catalogue search terms and leak into the
// UI as if the doctor had written them, so scrub them back to null here rather
// than trusting the model to follow the instruction.
const PLACEHOLDER =
  /^(n\.?\/?a\.?|none|null|nil|unknown|undefined|not\s*(specified|mentioned|available|given|provided|listed|written|legible|clear)|illegible|-{1,3}|\?+)$/i;

const clean = (v) => {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  const t = v.trim().replace(/[.,;]+$/, '');
  return !t || PLACEHOLDER.test(t) ? null : t;
};

const CONFIDENCES = ['high', 'medium', 'low'];

// Match a transcribed drug against the catalog. Tries the full name, then the
// first word — "Amoxicillin Clavulanate" should still find "Amoxicillin".
async function findCatalogMatches(med) {
  const terms = [clean(med.name), clean(med.brand)].filter(Boolean);
  if (!terms.length) return [];

  const firstWords = terms
    .map((t) => t.split(/\s+/)[0])
    .filter((w) => w && w.length >= 4);

  for (const group of [terms, firstWords]) {
    if (!group.length) continue;
    const or = group.flatMap((t) => {
      const rx = { $regex: escapeRe(t), $options: 'i' };
      return [{ name: rx }, { brand: rx }, { sku: rx }];
    });
    const found = await Medicine.find({ $or: or }).limit(5);
    if (found.length) return found;
  }
  return [];
}

// For a set of catalog SKUs, find who nearby has them and at what price.
async function offersForSkus(skus, { lat, lon, radius }) {
  if (!skus.length) return [];

  const query = { sku: { $in: skus }, ...AVAILABLE };

  if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
    const nearbyIds = await Pharmacy.find({
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: [lon, lat] },
          $maxDistance: radius,
        },
      },
    }).distinct('_id');
    if (!nearbyIds.length) return [];
    query.pharmacy = { $in: nearbyIds };
  }

  const rows = await Inventory.find(query).populate('pharmacy').limit(200);

  return rows
    .filter((r) => r.pharmacy)
    .map((r) => ({
      sku: r.sku,
      price: r.price ?? null,
      status: r.status,
      lastUpdatedAt: r.lastUpdatedAt,
      pharmacy: {
        _id: r.pharmacy._id,
        name: r.pharmacy.name,
        address: r.pharmacy.address,
        phone: r.pharmacy.phone,
        rating: r.pharmacy.rating,
        hours: r.pharmacy.hours,
        mapsLink: r.pharmacy.mapsLink,
        location: r.pharmacy.location,
      },
    }));
}

// POST /api/v1/ai/prescription
// Body: { image: "data:image/jpeg;base64,...", lat?, lon?, radius? }
exports.readPrescription = asyncHandler(async (req, res) => {
  if (rateLimited(String(req.user._id)))
    return res.status(429).json({
      message: `Scan limit reached (${RATE_LIMIT.max}/hour). Try again later.`,
    });

  const { image } = req.body || {};
  if (typeof image !== 'string' || !image.startsWith('data:'))
    return res.status(400).json({ message: 'image must be a base64 data URL' });

  const match = /^data:([^;,]+);base64,(.+)$/s.exec(image);
  if (!match) return res.status(400).json({ message: 'Malformed image data URL' });

  const [, mime, b64] = match;
  if (!ALLOWED_TYPES.includes(mime.toLowerCase()))
    return res.status(400).json({ message: 'Image must be JPEG, PNG or WebP' });

  // base64 inflates by 4/3; check the decoded size, not the string length.
  if (Math.floor((b64.length * 3) / 4) > MAX_IMAGE_BYTES)
    return res.status(413).json({ message: 'Image is too large (max 8 MB)' });

  const lat = parseFloat(req.query.lat ?? req.body.lat);
  const lon = parseFloat(req.query.lon ?? req.body.lon);
  const radius = parseInt(req.body.radius || req.query.radius || '5000', 10);

  let reading;
  try {
    reading = await visionJson({ dataUrl: image, system: SYSTEM, prompt: PROMPT });
  } catch (err) {
    if (err instanceof OpenRouterError)
      return res.status(err.status || 502).json({ message: err.message });
    throw err;
  }

  if (reading.isPrescription === false)
    return res.status(422).json({
      message: reading.notAPrescriptionReason || "That image doesn't look like a prescription.",
    });

  const extracted = (Array.isArray(reading.medicines) ? reading.medicines : [])
    // A row with nothing identifiable left after scrubbing is noise, not a drug.
    .filter((m) => m && (clean(m.name) || clean(m.brand)))
    .slice(0, 25);

  // Resolve each transcribed line against the catalog, then price it.
  const items = [];
  for (const med of extracted) {
    const matches = await findCatalogMatches(med);
    const offers = await offersForSkus(
      matches.map((m) => m.sku),
      { lat, lon, radius }
    );
    offers.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));

    const priced = offers.filter((o) => typeof o.price === 'number');

    items.push({
      prescribed: {
        name: clean(med.name),
        brand: clean(med.brand),
        strength: clean(med.strength),
        form: clean(med.form),
        dosage: clean(med.dosage),
        duration: clean(med.duration),
        quantity: clean(med.quantity),
        confidence: CONFIDENCES.includes(String(med.confidence).toLowerCase())
          ? String(med.confidence).toLowerCase()
          : 'medium',
      },
      catalog: matches.map((m) => ({
        _id: m._id,
        sku: m.sku,
        name: m.name,
        brand: m.brand,
        form: m.form,
        strength: m.strength,
        mrp: m.price ?? null,
        description: m.description || null,
        prescriptionRequired: m.prescriptionRequired,
      })),
      // Cheapest nearby offer, and the full list so the UI can compare shops.
      bestPrice: priced.length ? priced[0].price : null,
      offers: offers.slice(0, 10),
      availableNearby: offers.length,
    });
  }

  const estimatedTotal = items.reduce(
    (sum, i) => sum + (i.bestPrice ?? i.catalog[0]?.mrp ?? 0),
    0
  );

  res.json({
    prescription: {
      doctorName: clean(reading.doctorName),
      clinicName: clean(reading.clinicName),
      patientName: clean(reading.patientName),
      date: clean(reading.date),
      notes: (Array.isArray(reading.notes) ? reading.notes : []).map(clean).filter(Boolean),
    },
    items,
    estimatedTotal,
    unmatched: items.filter((i) => !i.catalog.length).length,
    searchedNear:
      Number.isNaN(lat) || Number.isNaN(lon) ? null : { lat, lon, radius },
    // Free routing can land on any model in the chain — useful when a scan
    // reads noticeably better or worse than the last one.
    model: reading._model || null,
    disclaimer:
      'Transcribed by AI from your photo and may contain errors. Always confirm with the pharmacist against the original prescription. Prices are indicative.',
  });
});
