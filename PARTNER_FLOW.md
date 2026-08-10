# Dawa-Find · B2B Partner Flow

How a medical shop registers, gets verified, and maintains its inventory — and
how that stock reaches the customer-facing search.

```
partner signs up (role=pharmacy)
        ↓
POST /partner/shop            → verificationStatus: pending
        ↓                       (stock writes blocked)
admin verifies licence        → verificationStatus: verified
        ↓
PUT /partner/inventory        → status per SKU + lastUpdatedAt
        ↓
GET /pharmacies/medicines/nearby   ← customer sees only in_stock rows
```

## Roles

| Role | Created by | Can do |
|---|---|---|
| `user` | self-serve register | search, view shops |
| `pharmacy` | self-serve register with `role: "pharmacy"` | own one shop, maintain its inventory |
| `admin` | `npm run seed:admin` only — never over the wire | verify licences, read metrics |

## Availability model

Each inventory row carries **both** a tri-state status and an optional count:

```js
{ sku: "MED-PARA-500", status: "in_stock", stock: 12, price: 24,
  updatedBy: "pharmacy", lastUpdatedAt: ISODate }
```

`status` is one of `in_stock` · `out_of_stock` · `unknown`. `unknown` is the
default and is meaningfully different from `out_of_stock` — it means the shop
has never touched that SKU. Write rules:

- Send `status` → it is used verbatim; `out_of_stock` forces `stock` to 0.
- Send only `stock` → status is derived (`> 0` → `in_stock`, else `out_of_stock`).
- Send neither → the existing status is kept, only `lastUpdatedAt` moves.

Only `status: "in_stock"` rows surface in customer search.

## Endpoints

### Partner — `Bearer` token, role `pharmacy`

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/partner/shop` | Register the shop. One per account. → `pending` |
| GET | `/api/v1/partner/shop` | My profile + verification state |
| PATCH | `/api/v1/partner/shop` | Edit profile. Changing `licenceNo` resets to `pending` |
| GET | `/api/v1/partner/inventory` | Stock board: every catalog SKU + my status |
| PUT | `/api/v1/partner/inventory` | Bulk upsert, max 500 items — **needs `verified`** |
| PATCH | `/api/v1/partner/inventory/:sku` | Single toggle — **needs `verified`** |
| POST | `/api/v1/partner/inventory/confirm` | "Still correct today" — bumps `lastUpdatedAt` only |

### Admin — `Bearer` token, role `admin`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/admin/pharmacies?status=pending` | Verification queue |
| PATCH | `/api/v1/admin/pharmacies/:id/verify` | `{ decision: "verified" \| "rejected", reason? }` |
| GET | `/api/v1/admin/metrics` | Verification counts, stock mix, 24h freshness |

## Automated test

```bash
npm run test:partner:local
```

Boots a disposable in-memory MongoDB, seeds pharmacies/medicines/admin, starts
the API on `:5099`, runs all 43 assertions, tears everything down. **Never
touches your Atlas cluster** — it temporarily moves `.env` aside and restores it.

To run against an already-running backend (uses your real `.env` / DB):

```bash
npm run dev                                        # terminal 1
node scripts/seedAdmin.js admin@dawafind.local admin12345
npm run test:partner                               # terminal 2
```

## Testing it in the browser

The partner console lives at these routes (role-gated client-side by
`RequireRole`, and independently by the API):

| Route | Role | What it does |
|---|---|---|
| `/register` | — | Pick "I run a medical shop" to sign up as `role: pharmacy` |
| `/partner` | `pharmacy` | Register/edit the shop; map pin picker; verification banner |
| `/partner/inventory` | `pharmacy` | Stock board — per-SKU toggles, qty, price, "Still accurate ✓" |
| `/admin` | `admin` | Verification queue + pilot metrics |

Login redirects by role: partners land on `/partner`, admins on `/admin`,
customers on the map.

### Sandbox backend (no MongoDB needed)

```bash
cd backend  && npm run dev:sandbox      # in-memory Mongo, seeded, :5000
cd frontend && npm run dev              # :5173
```

Prints an admin login (`admin@dawafind.local` / `admin12345`). Data is wiped on
Ctrl-C. If port 5000 is taken by your real backend:

```bash
cd backend  && PORT=5055 npm run dev:sandbox
cd frontend && API_PROXY=http://localhost:5055 npm run dev
```

### Click-through

1. `/register` → **"🏥 I run a medical shop"** → create account. You land on `/partner`.
2. Fill the shop form, click the map to drop the pin, **Register shop**.
   Banner turns amber: *awaiting verification*. Any nearby same-name scraped
   listings are reported as possible duplicates.
3. Go to `/partner/inventory` — every catalog SKU is listed as **Unknown**, and
   the controls are disabled with a read-only notice.
4. Open a private window → `/login` as the admin → `/admin` → **Verify**.
5. Back in the partner window, reload `/partner/inventory`. Controls unlock.
   Set a few SKUs to **In stock**, enter a price, **Save changes**.
6. Go to `/` and search that medicine — your shop appears with the stock you
   just published. Set it to **Out** and search again; it disappears.

## Manual curl walkthrough

```bash
BASE=http://localhost:5000/api/v1
```

**1 — Partner signs up**

```bash
curl -s -X POST $BASE/auth/register -H 'Content-Type: application/json' -d '{
  "name":"Sri Sai Medicals","email":"partner@example.com",
  "password":"partner12345","phone":"+91 9000000001","role":"pharmacy"
}'
# → { token, user: { role: "pharmacy", pharmacy: null } }
PT=<token from above>
```

**2 — Register the shop**

```bash
curl -s -X POST $BASE/partner/shop -H "Authorization: Bearer $PT" \
  -H 'Content-Type: application/json' -d '{
  "name":"Sri Sai Medicals",
  "address":"Door 4-21, MG Road, Benz Circle, Vijayawada - 520010",
  "phone":"+91 9000000001","hours":"Mon - Sun :- 8:00 am - 11:00 pm",
  "licenceNo":"AP/20B/1234","lat":16.5045,"lon":80.6540
}'
# → 201 { pharmacy: { verificationStatus: "pending", source: "partner" },
#          possibleDuplicates: [ ...nearby same-name scraped listings... ] }
```

`possibleDuplicates` is advisory — the shop may already exist as one of the 99
scraped listings. Registration is not blocked; reconcile later.

**3 — Stock writes are blocked while pending**

```bash
curl -s -X PUT $BASE/partner/inventory -H "Authorization: Bearer $PT" \
  -H 'Content-Type: application/json' -d '{"items":[{"sku":"MED-PARA-500","status":"in_stock"}]}'
# → 403 { code: "NOT_VERIFIED" }
```

The board is still readable while pending, so the shop can see its SKU list.

**4 — Admin verifies**

```bash
node scripts/seedAdmin.js admin@dawafind.local admin12345

AT=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@dawafind.local","password":"admin12345"}' | jq -r .token)

curl -s "$BASE/admin/pharmacies?status=pending" -H "Authorization: Bearer $AT"
curl -s -X PATCH $BASE/admin/pharmacies/<shopId>/verify -H "Authorization: Bearer $AT" \
  -H 'Content-Type: application/json' -d '{"decision":"verified"}'
```

**5 — Publish stock**

```bash
curl -s -X PUT $BASE/partner/inventory -H "Authorization: Bearer $PT" \
  -H 'Content-Type: application/json' -d '{"items":[
    {"sku":"MED-PARA-500","status":"in_stock","price":24},
    {"sku":"MED-AZI-500","stock":12},
    {"sku":"MED-ORS-1","status":"out_of_stock"}
  ]}'
# → { created, updated, rejected: [], lastUpdatedAt }
```

Unknown SKUs come back in `rejected` rather than being silently dropped.

**6 — Single toggle, and daily confirm**

```bash
curl -s -X PATCH $BASE/partner/inventory/MED-PARA-500 -H "Authorization: Bearer $PT" \
  -H 'Content-Type: application/json' -d '{"status":"out_of_stock"}'

curl -s -X POST $BASE/partner/inventory/confirm -H "Authorization: Bearer $PT"
# → { confirmed: 3, lastUpdatedAt }
```

**7 — Customer search reflects it**

```bash
curl -s "$BASE/pharmacies/medicines/nearby?name=Azithromycin&lat=16.5045&lon=80.6540&radius=2000"
# → inventory rows incl. the partner shop, each with status + lastUpdatedAt
```

## Not built yet

- **48h decay cron** — `lastUpdatedAt` is recorded but nothing decays stale rows
  back to `unknown`. Add `node-cron` in `server.js`.
- **Reservations** — the plan's pickup-code flow.
- **Medicine autocomplete / same-salt fallback** — the catalog is 10 SKUs with no
  `salt` or `aliases` field, so neither is possible yet.
- **Rate limiting / schema validation** — no `helmet`, `express-rate-limit`, or zod.
