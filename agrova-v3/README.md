# Agrova V3 — Crop Recovery, Shortage Fulfillment & Settlement OS

**Team INNOVATRIX** · Working hackathon prototype · No production buyer network or payment rails.

Agrova follows an FPO's buyer mismatch in **three connected tracks**: (1) recover incompatible-but-cleared produce with an eligible alternative buyer, (2) source missing compatible crop for the original buyer, and (3) reconcile delivery evidence and settlement quantities.

## 1. Run in VS Code (Windows / macOS / Linux)

**Requirements:** Node.js **22+**. No `npm install`, database account, or other dependencies required.

1. Extract the ZIP. Open **the `agrova-v3` folder** in VS Code using **File → Open Folder**.
2. Open **Terminal → New Terminal**.
3. Run:

```bash
node -v
npm start
```

4. Open **http://localhost:3000**. Keep the terminal running.

On Windows you can also double-click **`START-WINDOWS.bat`** inside the project folder.

If port 3000 is busy, copy `.env.example` to `.env`, change `PORT=3001`, restart and open `http://localhost:3001`.

### Demo logins

| Account | Email | Password |
|---|---|---|
| FPO Manager | `manager@agrova.test` | `Agrova123!` |
| SauceWorks buyer | `sauce@agrova.test` | `Buyer123!` |
| FreshMart buyer | `fresh@agrova.test` | `Buyer123!` |

These are **local demonstration credentials**. New manually entered suppliers/buyers do not automatically get login accounts. The partner supplier confirmation button is explicitly **simulated**. Do not deploy this configuration to the public internet.

## 2. What's actually implemented in V3

| Module | Actual behaviour |
|---|---|
| Overview | Received stock, original buyer shortage, recovery commitment and evidence disputes |
| Lots & quality | Farmer lots, editable quantity/grade/safety, reservation locks; internal lot quality passport |
| Buyer orders | Crop/grade/quantity/rate, estimated transport/handling costs, changeable demand |
| **Supply Gap Resolver (NEW)** | Enter partner quotations; simulate confirmation; independently inspect received supply; create lots; allocate eligible stock to original buyer with transactional overbooking checks |
| Recovery cases | Matched alternative buyer offer → buyer acceptance (or clearly labelled demo) → FPO reservation → delivery inspection |
| **Net Recovery Optimizer (NEW)** | Compares eligible alternative buyers using gross value minus entered transport/handling estimates; recalculates with modified values |
| Settlement & review | Upload TXT/PDF/photo evidence, optional Gemini extraction, human field verification, deterministic discrepancy calculations, review log; no payment execution |
| **Farmer Ledger (NEW)** | Farmer/lot-wise provisional gross payable, delivery quantities, disputed amounts; payment deliberately shown unintegrated |
| Quality Passport (NEW) | Manager-visible crop, grade, safety, revision, available quantity, linked source/allocations; not an external certificate |
| Activity log | Transaction and approval events |
| Access | Manager and buyer accounts backed by server sessions and SQLite |

**Tech stack:** Node.js 22 built-in HTTP server, plain JavaScript/HTML/CSS, built-in SQLite with transactional writes, optional Gemini API. This is intentionally not yet Next.js/Supabase. Code is dependency-free so mentors can run it offline.

## 3. Judge demo — V3 storyline (illustrative figures)

Start fresh by clicking **Reset demo** (it wipes working demo records and re-seeds illustrative data).

### Part A: Original shortage (NEW)

1. Overview: 95 kg tomatoes available, but FreshMart needs 80 kg Grade A; only 55 kg Grade A qualifies, leaving **25 kg** short.
2. Open **Supply gap resolver**. Click **Allocate currently eligible stock**. 30 kg from Asha and 25 kg from Meena are reserved for FreshMart; shortage remains **25 kg**.
3. Two *illustrative* partner quotations exist: North Valley Partner FPO (**15 kg**) and Greenfields Partner FPO (**10 kg**). Click **Simulate supplier confirmation** on each, then **Receive & inspect** each as Grade A, `cleared`.
4. Source receiving creates `LOT-004` and `LOT-005`. The coverage gap becomes zero because 25 kg new Grade A has entered inspected stock.
5. Click **Allocate currently eligible stock** again. FreshMart now has **80 kg allocated**. Status remains **reserved / dispatch pending**, *not* buyer-accepted or paid. Optionally record dispatch on allocation rows.
6. For a negative test, reset; receive a partner quote as Grade **B** or on **safety hold**—it must **not** eliminate the FreshMart Grade A shortage.

### Part B: Grade B recovery + economics

7. Ravi's 40 kg is safe Grade B, so it cannot fulfill FreshMart's Grade A order. Open **Net recovery** and select `LOT-002`.
8. Seeded buyers demonstrate why maximum rate is not maximum profit: SauceWorks pays **₹16/kg**, with illustrative ₹30 transport + ₹5 handling; CityFresh pays **₹18/kg**, with illustrative ₹100 transport + ₹10 handling. For 30 kg, the respective estimated net values are **₹445** and **₹430**. The system ranks the higher estimated net, **subject to eligibility**.
9. Change CityFresh's transport costs in **Buyer orders** and revisit Net recovery; ranking should change if its estimated net becomes higher.
10. Open **Recovery case** → propose **30 kg** to SauceWorks → demonstrate buyer acceptance as buyer account (or use the marked simulation) → manager confirms reservation. Ravi has **10 kg unreserved**; FreshMart's original fulfillment remains a separate workflow.

### Part C: Evidence & settlement

11. Deliver 30 kg to SauceWorks. Record **28 kg accepted, 2 kg rejected**.
12. **Settlement & review:** Upload `sample-receipts/inspection.txt` as inspection and `sample-receipts/buyer-statement.txt` as buyer statement. Use **Parse text** (or Gemini extract if configured), and **Verify fields** against each document.
13. Verified inspection **28 kg** vs buyer **25 kg**, agreed ₹16/kg → **3 kg difference, ₹48 under review**, provisional inspection gross **₹448**. Change the buyer statement to 21 kg and the difference becomes **₹112**, proving it isn't a fixed result.
14. Record a reviewer decision and reason; go to **Farmer ledger** and **Activity log**. Settlements are **never silently marked paid**.

### Round 2 Change 1: correct verified evidence

The FPO manager sees **Verify fields** only on unverified inspection receipts and buyer statements. Once verified, the action becomes **Correct**. The correction form starts with the current verified values, not a fresh extraction. It requires a reason of 10–1000 characters after trimming; accepted quantity cannot exceed either the document's delivered quantity (when provided) or the recorded delivery quantity. Buyers cannot open or submit corrections.

The first-time `POST /api/evidence/:id/verify` endpoint rejects repeat verification with HTTP 409. Corrections use `POST /api/evidence/:id/correct` and include the edited fields, `reason`, and `expected_verified_json` (the exact JSON of the values loaded into the form). A stale form is rejected with HTTP 409. A successful correction records the manager, reason, explicit old/new accepted kg, and full previous/corrected snapshots in an `EVIDENCE_CORRECTED` event, recalculates settlement, and reopens any earlier review. A no-change submission is rejected.

### Round 2 Change 2: permanent evidence versions

First verification creates Version 1 for either an inspection receipt or buyer statement without requiring a correction reason. Every correction appends a new `evidence_versions` row with the complete verified JSON, reason, manager ID, version number, and timestamp in the same transaction as the evidence update and audit event. SQLite triggers reject updates and deletes of version rows. Reconciliation reads the newest stored version, so an outdated legacy `evidence.verified_json` mirror cannot change the result. Settlement & Review displays the history newest first and marks the current version. Corrections after a recorded review reopen the delivery as `needs_review`, including when the latest evidence quantities agree.

Opening an older database migrates verified evidence into version history without overwriting existing version rows. Where earlier correction audit snapshots exist, migration reconstructs their sequence; where provenance is missing, only the current verified snapshot can be recovered. The demo reset preserves historical version rows and does not reuse their evidence IDs. This is append-only protection within the local SQLite application, not a substitute for off-host backups or production-grade audit security.

### Fast demo tip

Keep the demo under 4–5 minutes and explain that V3 partner quotes/buyer transport charges are **illustrative**, not live vendor quotes. For judges who demand proof, edit quantities and costs and show genuine recalculation.

## 4. Test commands

```bash
npm test
```

Runs automated business-rule and isolated API tests, including first verification without a reason, append-only version history, legacy migration, newest-version reconciliation, manager correction, reason/quantity validation, and repeat-verification rejection.

Run the end-to-end smoke workflow safely against a temporary copy of the server and a disposable database:

```bash
npm run smoke:isolated
```

With `npm start` running in a different terminal:

```bash
npm run smoke
```

This direct command performs the same workflow against the server at `TEST_BASE_URL`: sourcing 15+10, allocation of 80, Grade B recovery 30 and a **₹48** settlement discrepancy. **CAUTION: `npm run smoke` intentionally resets and mutates that server's demo records. Use `smoke:isolated` unless the target server is disposable.**

For a nondefault port, set `TEST_BASE_URL=http://localhost:3001` before running the smoke command.

## 5. Optional Gemini document extraction

1. Copy `.env.example` → `.env`.
2. Set `GEMINI_API_KEY=...` on the server side (never in `public/app.js`).
3. Restart. Upload TXT/PDF/photo evidence and choose **AI extract**; always verify every field before the rules engine uses it.

If the key is absent: TXT files are parsed by an honest **non-AI rule-based parser**. PDF/photos can still be uploaded and fields entered manually. An unreachable Gemini service returns an error, not fake AI output.

## 6. Architecture and data boundaries

```
Browser UI (FPO manager and buyer)
         |
HTTP API + session-based roles (Node.js)
         |
Transactional SQLite database
         +-- Lots, orders, offers, delivery inspections
         +-- Supplier quotes → simulated confirmation → inspected lots
         +-- Original-order allocations, recovery reservations
         +-- Private evidence, verified extracted fields, reviews, event log
         |
Optional Gemini API (document extraction only)
```

The sourcing inventory, original allocations and recovery reservations share **one inventory pool**; the backend uses `BEGIN IMMEDIATE` transactions so a reserved kilogram cannot be sold again from the same server DB. A quote alone never changes available stock. Rejected produce is not automatically returned to eligible stock. The original order remains allocation/dispatch tracked; buyer receipt and bank payment are not claimed.

Private files live in `storage/` along with `agrova.sqlite` and are omitted from the ZIP. Reset demo clears database records but does not delete historic evidence bytes in this MVP; do not use real personal/commercial documents. This is a local showcase system, not an internet-facing production service.

## 7. Important limitations (tell judges accurately)

- Supplier network, supplier acceptance, prices and transport costs are **illustrative/manual**, not a verified live marketplace or logistics service. Partner confirmations are simulation actions.
- The **buyer portal** is authentic to the local demo, but new supplier accounts and supplier-specific document permissions are not implemented.
- Quality passport is an **internal record**, not a government laboratory certification.
- No buyer-side acceptance for the original order, no real funds transfer, no automated proof of supplier stock, no national price feed, no real shipping integration.
- No per-organisation tenant isolation or audit-grade security hardening. Passwords are for a local demo. Production requires hardened auth, HTTPS, CSRF/session protections, malware scanning, rate limits, DB backup/migrations, regulatory review and proper reconciliation processes.
- Received partner supply has a simple one-grade inspection entry; real centres may need grade splits, separate custody and rejection handling.
- SQLite transactions protect this single shared server database, not multiple independently deployed replicas. For scale use PostgreSQL with transactional locking and organisation-level access control.
- Gross provisional farmer ledger values are **not verified payouts**, and sourcing quotations do not establish actual business commitments.

## 8. Project structure

```text
agrova-v3/
├── server.mjs                HTTP API and role enforcement
├── lib/db.mjs                SQLite schema, seed data, audit trail
├── lib/domain.mjs            Existing eligibility, matching and reconciliation
├── lib/v3.mjs                New shortage, inventory, net economics functions
├── public/app.js             All V3 workspaces and dialogs
├── public/styles.css         Responsive Agrova visual system
├── public/index.html         App entry point
├── sample-receipts/          Two editable demo TXT documents
├── tests/                    14 automated Node unit tests
├── scripts/smoke-test.mjs    Full API workflow; resets demo records
├── START-WINDOWS.bat         Double-click Windows launcher
├── .env.example              Optional Gemini + port configuration
└── package.json
```

**Positioning:** Agrova is an FPO exception-management prototype: recover eligible mismatched stock, address the original order's supply gap and reconcile farmer settlement evidence in a connected workflow. It's not a guarantee of crop sale or lower agricultural waste without customer validation.
