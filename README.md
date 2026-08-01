# Dawa-Find · Backend

REST API powering **Dawa-Find**, a real-time pharmacy & medicine locator for Vijayawada. Built with Node.js, Express, and MongoDB (with 2dsphere geo-indexing) — exposes JWT-based auth, geo-search over pharmacies, and a medicine/inventory catalog.

> Frontend repo: [dawa-find-frontend](https://github.com/<your-username>/dawa-find-frontend)

---

## ✨ Features

- 🔐 **JWT auth** — register, login, logout, `me`
- 🗺️ **Geo-search** — MongoDB 2dsphere `$near` queries for nearby pharmacies
- 💊 **Medicine catalog** — SKU-based medicine directory
- 📦 **Inventory** — many-to-many link between pharmacies and medicines with per-shop stock & price
- 🔎 **Find-nearby-medicine** — joins Medicine ⨯ Inventory ⨯ Pharmacy, filtered by geo radius
- 🌱 **Seed scripts** — one for pharmacies (Just Dial dataset), one for medicines + sample inventory

---

## 🧱 Tech stack

| Layer | Tool |
|-------|------|
| Runtime | Node.js 18+ |
| Framework | Express 4 |
| Database | MongoDB 6+ (Mongoose 8) |
| Auth | JSON Web Tokens (`jsonwebtoken` + `bcryptjs`) |
| CORS | `cors` |
| Env | `dotenv` |
| Dev reload | `nodemon` |

---

## 📁 Project structure

```
backend/
├── config/db.js               # Mongoose connection
├── controllers/               # Route handlers
│   ├── authController.js
│   ├── pharmacyController.js
│   └── medicineController.js
├── models/                    # Mongoose schemas
│   ├── User.js
│   ├── Pharmacy.js            # + 2dsphere index on `location`
│   ├── Medicine.js
│   └── Inventory.js
├── routes/
│   ├── authRoutes.js
│   ├── pharmacyRoutes.js
│   └── medicineRoutes.js
├── middleware/auth.js         # `protect` JWT middleware
├── scripts/
│   ├── seedPharmacies.js
│   └── seedMedicines.js
├── data/
│   ├── pharmacies.json        # Just Dial scrape
│   └── medicines.json         # Catalog of 10 sample SKUs
└── server.js                  # App entry
```

---

## ⚙️ Setup

### 1. Clone & install

```bash
git clone https://github.com/<your-username>/dawa-find-backend.git
cd dawa-find-backend
npm install
```

### 2. Environment

Copy the example and fill in your values:

```bash
cp .env.example .env
```

```
PORT=5000
MONGO_URI=mongodb://127.0.0.1:27017/dawafind
# or Atlas:
# MONGO_URI=mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/dawafind?retryWrites=true&w=majority
JWT_SECRET=change_me_super_secret
JWT_EXPIRES_IN=7d
CLIENT_ORIGIN=http://localhost:5173
```

### 3. Seed the database

Order matters — pharmacies first, medicines second:

```bash
npm run seed              # loads ~150 Vijayawada pharmacies
npm run seed:medicines    # loads 10 medicine SKUs + links the first 2 shops
```

### 4. Run

```bash
npm run dev               # http://localhost:5000
```

Health check: `GET http://localhost:5000/api/health` → `{ "ok": true }`

---

## 📚 API reference (v1)

Base path: `/api/v1`

### Auth
| Method | Endpoint | Body |
|--------|----------|------|
| POST | `/auth/register` | `{ name, email, password }` |
| POST | `/auth/login`    | `{ email, password }` |
| POST | `/auth/logout`   | — |
| GET  | `/auth/me`       | (Bearer token) |

### Pharmacies
| Method | Endpoint | Notes |
|--------|----------|-------|
| GET | `/pharmacies` | All (max 2000) |
| GET | `/pharmacies/:id` | Single |
| GET | `/pharmacies/nearby?lat=&lon=&radius=` | `$near`, radius in metres (default 5000) |
| GET | `/pharmacies/:id/inventory` | Full inventory with populated medicine details |
| GET | `/pharmacies/medicines/nearby?name=&lat=&lon=&radius=` | Inventory rows for shops within radius stocking a medicine matching `name` |

### Medicines
| Method | Endpoint |
|--------|----------|
| GET | `/medicines` |
| GET | `/medicines/:sku` |
| GET | `/medicines/:sku/pharmacies?lat=&lon=&radius=` |

### Example
```bash
# All pharmacies within 5 km of Benz Circle
curl "http://localhost:5000/api/v1/pharmacies/nearby?lat=16.5045&lon=80.6540&radius=5000"

# Shops nearby that stock paracetamol
curl "http://localhost:5000/api/v1/pharmacies/medicines/nearby?name=paracetamol&lat=16.5045&lon=80.6540&radius=5000"
```

---

## 🌱 Data

- `data/pharmacies.json` — scraped from Just Dial (name, address, phone, lat/lon, rating, hours, image).
- `data/medicines.json` — 10 common medicines with SKU, brand, form, strength, MRP.
- Seed script picks the first two pharmacies and populates real inventory (Shop A: SKUs 1–6, Shop B: SKUs 5–10 with +₹5).

---

## 📦 Scripts

| Command | What it does |
|---------|--------------|
| `npm start` | Production start |
| `npm run dev` | Nodemon dev server |
| `npm run seed` | Seed pharmacies |
| `npm run seed:medicines` | Seed medicines + sample inventory |

---

## 🛣️ Roadmap

- [ ] Partner/pharmacy self-serve inventory dashboard
- [ ] Prescription upload + OCR
- [ ] Real-time stock alerts (WebSockets)
- [ ] Ratings & reviews
- [ ] Rate limiting + request logging

---

## 📄 License

MIT
