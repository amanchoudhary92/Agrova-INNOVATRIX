# Agrova V3.1 — Stage 2 Backend Upgrade

**Purpose:** Replace the previous incomplete Stage 2 patch with an additive, tested B2B-market backend while preserving Agrova V3 frontend, original recovery/settlement APIs, and database records.

## Contents (only the following 6 files)

- `server.mjs`: existing V3 server + market API routing and PDF download support
- `lib/db.mjs`: additive missing V3.1 auth-token schema, FPO profile column and scoped workspace helpers
- `lib/marketplace.mjs`: farmer/FPO/buyer roles, inventory, matching, orders, demo payments, invoices, delivery and rating endpoints
- `lib/market_pdf.mjs`: downloadable **SAMPLE / DEMO** invoice PDF generator
- `tests/marketplace.test.mjs`: isolated regression tests, including wrong-FPO access and payment edge cases
- `STAGE2_V3_1_INSTALL.md`: this guide

**Not included:** `.env`, `storage/`, `public/`, secrets, or any original dataset. It is a patch, not a standalone project ZIP.

## Windows installation — laptop running C:\Users\enggb

1. **Stop the Node server** in the PowerShell where `npm start` is running (Ctrl+C). Stop other copies of Agrova on either laptop before backing up or replacing files.
2. In PowerShell:

```powershell
cd C:\Users\enggb\Downloads\Agrova-INNOVATRIX\agrova-v3
Get-Location
git status

# Back up DB including WAL/SHM while server is STOPPED. Keep backup outside repository.
$backup = Join-Path $env:USERPROFILE ("Downloads\Agrova-DB-Backup-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
Copy-Item .\storage $backup -Recurse
Write-Host "DB backup: $backup"

# Back up only the source files being replaced.
Copy-Item .\server.mjs .\server.mjs.before-stage2
Copy-Item .\lib\db.mjs .\lib\db.mjs.before-stage2
if (Test-Path .\lib\marketplace.mjs) { Copy-Item .\lib\marketplace.mjs .\lib\marketplace.mjs.before-stage2 }
```

3. Extract this ZIP. Copy **only** `server.mjs`, `lib/db.mjs`, `lib/marketplace.mjs`, `lib/market_pdf.mjs`, `tests/marketplace.test.mjs` into the matching locations in your existing `agrova-v3` project. Also copy this document if useful. **Do not replace the whole project directory.**
4. Verify syntax and run tests:

```powershell
node --version             # Node >=22 required
node --check server.mjs
node --check lib\db.mjs
node --check lib\marketplace.mjs
node --check lib\market_pdf.mjs
npm test
npm start
```

5. Open http://localhost:3000 and verify existing login and dashboards first. Then check http://localhost:3000/api/health. `npm test` runs its market tests in temporary isolated databases and does not reset your existing data.
6. Review `git status`, `git diff --stat`, and test output before committing. **Do not push directly to `main`**.

## Demo API overview (authenticated session cookie)

Use existing admin (`manager@agrova.test` if it is still installed locally) to create FPOs and provision market users; an admin-created user has a standard login account plus an additional scoped marketplace role. New account email verification is **not** claimed; these are demo administrator-provisioned accounts.

- `POST /api/market/fpos` (admin): `{ "name":"Green FPO", "location":"Delhi" }`
- `POST /api/market/members` (admin): `{ "email":"buyer1@example.com", "display_name":"Buyer One", "password":"StrongPass123", "role":"buyer" }` or `"role":"farmer"|"fpo", "fpo_id":"<fpo id>"`
- `GET /api/market/me` profile; `GET /api/market/farmers` scoped farmer roster
- `POST /api/market/listings` (admin, FPO or linked farmer): `{ "fpo_id":"<id>", "farmer_name":"Ravi", "crop":"Tomatoes", "grade":"A", "stock_kg":50, "price_paise":2200, "estimated_distance_km":25, "transport_paise":5000 }`
- `GET /api/market/listings` scoped listing data, `PATCH /api/market/listings/{id}` stock and price
- `GET /api/market/matches?crop=Tomatoes&grade=A&quantity_kg=20` cheapest delivered / nearest / best value / highest-rated eligibility
- `POST /api/market/orders` (buyer): `{ "listing_id":"<id>", "quantity_kg":20, "idempotency_key":"unique-buyer-request-key" }`
- `GET /api/market/orders` scoped buyer or FPO orders
- `POST /api/market/orders/{id}/payment` **DEMO ONLY** buyer `{ "scenario":"success"|"failure"|"uncertain"|"reconcile_success"|"reconcile_failure" }`
- `GET /api/market/invoices` scoped invoice index; `GET /api/market/orders/{id}/invoice` sample JSON; `GET /api/market/orders/{id}/invoice.pdf` sample PDF
- `POST /api/market/orders/{id}/delivery` admin or authorized FPO; returns **development-only demo OTP**
- `POST /api/market/orders/{id}/confirm-delivery` buyer: `{ "otp":"123456", "photo_mime":"image/png", "photo_base64":"<base64>" }` with valid image magic bytes; 30-minute OTP expiry, 5-attempt limit
- `GET /api/market/orders/{id}/delivery-status` scoped status & audit timeline
- `POST /api/market/orders/{id}/rating` buyer after delivered: `{ "stars":5, "comment":"Good quality" }`
- `GET /api/market/ratings` verified review statistics and minimum review count rule
- `GET /api/market/overview` admin operational summary

## Preservation, limitations, and known follow-up work

- Existing `lots`, `orders`, `offers`, `deliveries`, etc. are **not deleted or overwritten** by the patch. The demo reset route in the existing project **still exists**; **do not click/reset the demo** on a database containing work you need to retain.
- SQLite migrations are additive and executed on app start. A backout after migration requires the backup if you must reverse the database schema; replacing only source code will not remove added columns/tables.
- Demo payments **do not move real money**, issue receipts from a payment provider or process actual refunds. `NODE_ENV=production` disables the simulator.
- Sample invoice is a downloadable PDF but **NOT** a GST/compliant tax invoice. It uses a snapshot of order prices and quantity.
- Distances/transport are **entered estimates**, not actual shortest road routes. Recommendations use an explainable heuristic. No courier booking or tracking integration.
- Delivery photo uses basic file-signature checks. It is not forensic proof. Locally stored photo data has no production-grade retention/consent workflow. OTP is shown to the dispatch user only in non-production demos.
- Legacy `manager` has global administrator privileges in the marketplace. New scoped FPO users are separate buyer-base accounts plus a marketplace FPO role to preserve the existing SQLite role CHECK and frontend compatibility.
- Stage 1 screens remain **unconnected** to the new market APIs. **Stage 3** must wire them to real HTTP endpoints and do browser UX testing. The patch cannot be described as a fully integrated frontend/backend product yet.
- External network/payment emails and SMS, live buyer location routing, real courier tracking, independent legal certification and production hardening are not implemented.

## Verification performed on a clean isolated copy

- Node syntax checks for all changed .mjs files.
- `npm test`: **21 passed, 0 failed**, including the existing auth/domain/V3 tests.
- Actual HTTP test: server startup, login, new FPO, market user creation, listing, matching, order, simulated payment and sample PDF retrieval passed.
- PDF parsed successfully by `pdfinfo`/`pdftotext`.

## Source-code rollback

Stop server, restore `server.mjs.before-stage2` and `lib/db.mjs.before-stage2`; if present restore `lib/marketplace.mjs.before-stage2`. Only if a full data/schema rollback is truly needed, restore the timestamped `storage` backup **while server is stopped**. Do not delete the latest database without an independently verified backup.
