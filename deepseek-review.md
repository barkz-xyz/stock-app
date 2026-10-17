# Bakery POS — Deep Review / Stress-Test Report

> Historical review from 2026-09-08. The 2026-10-17 production release fixes malformed-cookie handling, requires an independent session secret, bounds login-attempt storage, limits proxy trust to Railway, validates product expiry dates, and patches dependency advisories. The findings below describe the original audit state. Financial refund amounts and physical product returns remain intentionally separate.

**Date:** 2026-09-08
**Scope:** Full-stack audit of `stock-app` (Express 5 + React 19 + Vite + PostgreSQL/JSON), all docs + tests, live run, API stress battery, auth attack battery, real-browser UI flow.
**Method:** read all docs (README, ROADMAP, backup.md, ASTRYX_MIGRATION, SII docs×3, docs/*), all server/src code, all tests → `npm run check`, `npm test` (15/15 pass), `npm run build` (passes) → ran server locally twice (JSON store + mock Point, and JSON store + staff PIN) → ~70 live HTTP probes + real headless-browser POS flow.
**No code was modified.** All test data used throwaway JSON files (now deleted).

---

## Executive summary

Stable and unusually well-tested for its size: 15/15 automated tests pass, syntax checks pass, production build passes, and every stress case I threw at it behaved (stock never goes negative, refunds are idempotent, duplicate webhooks don't double-deduct, card-sale cancellation restores stock exactly once, delete is blocked while a sale is pending, brute-force lockout works).

That said, I found **1 crash-level bug**, **2 security hardening gaps**, and a set of **data-integrity and hygiene issues** worth fixing before real use. No critical "money disappears" bug was found; the riskiest items are the auth 500 and the refund/restock integrity gap.

---

## Confirmed bugs (reproduced live)

### B1 — Malformed cookie causes HTTP 500 instead of 401 (crash bug, all deployments with PIN)
**Reproduction** (server with `STAFF_PIN` set):

```
curl -H 'Cookie: bakery_session=%' http://host:3000/api/items
→ HTTP 500 {"error":"Something went wrong. Please try again."}
```

**Root cause:** `server/auth.js` `parseCookies()` calls `decodeURIComponent()` with no try/catch. A cookie value containing a lone `%` throws `URIError`, which escapes to the Express error handler as a 500.
**Worse:** any malformed cookie *earlier in the header* breaks the whole request even when a valid session cookie is also present (`Cookie: a=%ZZ; bakery_session=<valid>` → 500), so a single bad cookie can knock out an entire logged-in browser session until the user clears cookies.
**Fix:** wrap `decodeURIComponent` in try/catch; on failure treat the whole cookie header as unauthenticated (401), never 500. Add a regression test for `%` and for malformed-first-cookie + valid-second-cookie.

### B2 — Refund amount vs. selected line items are never cross-checked (data-integrity gap)
**Reproduction:** sale = 1×Sourdough (CLP 4200) + 1×Zeb Cake (CLP 6000) = CLP 10200. Then:

```
POST /api/sales/<id>/refunds  { amount: 6000, items: [{ lineId: <sourdough line>, quantity: 1 }], restock: true }
→ 201 accepted. Refund record: amount=6000, items=[sourdough lineTotal 4200], restock restored 1 sourdough unit.
```

The UI text says the amount "may differ from the returned products' price" — so a custom amount is intended. But the server places **no constraint at all** between `amount`, `items`, and per-line totals:

- A cashier/API caller can refund a larger amount than the items returned, or select items worth *more* than the refund amount, and restock happens by **line quantity**, not by amount → **over-restocking or under-restocking inventory relative to the money moved**.
- Full-refund detection (`full`), sale status (`refunded`), and metrics all key off **amount**; unit-based metrics and stock key off **items**. They can disagree.
- Minimal gap example: refund `amount: 4200` selecting the Zeb line (6000 value, 1 unit) → CLP 4200 was refunded but 1 unit worth CLP 6000 went back on the shelf.

**Fix (recommended):** server-side, when `items` are supplied, require `sum(item.lineTotal) <= amount` (or exactly equal) and derive the restockable set from it; fall back to an explicit "remainder has no returned product" flag. Add tests for amount>lines and lines>amount.

---

## Security findings

### S1 — Stop-attack lockout can be bypassed with a spoofed `X-Forwarded-For`; map grows unbounded
`server/index.js` sets `app.set('trust proxy', 1)` unconditionally, and `server/auth.js` keys the 8-attempt/10-minute lockout on `req.ip`. On Railway (behind a real proxy) this is correct; on any direct or differently-proxied deployment an attacker can rotate `X-Forwarded-For` to reset the counter every 8 attempts. The `attempts` `Map` also never prunes entries, so IP rotation is an unbounded memory growth vector (every spoofed IP adds a permanent entry).
**Fix:** require the proxy trust decision to be configurable (`TRUST_PROXY=1` or Railway-environment detection), and prune expired `attempts` entries periodically (e.g. on each hit, or a size-capped `Map`).

### S2 — Sessions are signable with a PIN-derived secret when `SESSION_SECRET` is missing
`server/auth.js`: `sessionSecret = configuredSecret || sha256('bakery-session:' + staffPin)`. If an operator sets `STAFF_PIN` but forgets `SESSION_SECRET` (easy to do — both are optional, and there is no startup guard), every session cookie is a deterministic HMAC of the PIN. Anybody who knows/guesses the 4-digit PIN can forge a session cookie directly, bypassing the login screen entirely. Live Point is blocked in that state (`productionReady: false`), but cash operations and all inventory/sales data are exposed. (SSRF note: cookie is also not `Secure` unless `NODE_ENV=production` or Railway env vars are present — a custom-HTTPS host lacks the flag.)

**Fix:** fail fast at startup when `STAFF_PIN` is set but `SESSION_SECRET` is not (or auto-generate and refuse persistence) — don't silently fall back to a derivable key. Add a forged-cookie regression test.

### S3 — Webhook signature-validation fallback is a deliberate, documented weakening
`server/index.js` webhook handler: an invalid signature is still honoured when `dataId` looks like `^ORD[A-Z0-9]{20,}$` **and** maps to a known sale, to work around observed live Point signature quirks. It's logged, it can't create/refund anything, and the high-entropy ID requirement makes casual forgery impractical — acceptable compromise, but it means "validates x-signature" is not strictly true. Worth re-tightening once MP's signature format is stabilised on the physical terminal.

### S4 — Minor hardening gaps
- No `helmet`/CSP/`X-Frame-Options`/`Referrer-Policy` on the app's own responses (the exported HTML report has a CSP; the app pages don't). Login is a prime clickjacking/phishing surface if the app is ever framed.
- Login screen has no rate-limit *notice*; 429 works but the UX is just a generic error.
- `.env.example` still documents retired `POINT_PILOT_*` variables (see H1).

---

## Data-integrity / correctness notes

### D1 — `expiryDate` is never validated (500 on PostgreSQL, silent garbage on JSON)
`cleanItem()` passes `body.expiryDate` through untouched. In JSON mode `dateOnly()` normalizes garbage to `null` on read (silent data loss); against PostgreSQL an invalid string is bound to a `DATE` column → `22P02` → HTTP 500. Also `expiryDate: 'not-a-date'` should be a 400, not a stored/500 case. Add format validation in `cleanItem` and a test.

### D2 — Booleans and exponent strings pass numeric validation
`Number(true)` = 1 and `Number('1e3')` = 1000, so `quantity: true` or `price: '1e3'` are silently coerced instead of rejected. Low impact (stock math stays consistent), but the API's "rejects invalid fields" claim is softer than advertised. Strict: require `typeof value === 'number'` for numeric fields.

### D3 — `PATCH /api/items/:id` behaves like a PUT
`cleanItem(body, true)` still requires `name`, `category`, `unit` on update, so a partial PATCH (change price only) → 400. The shipped UI always sends the full object so nothing breaks today; just note that the route contract is steeper than PATCH semantics if third-party clients ever appear.

### D4 — SKU has no uniqueness constraint
Duplicate SKUs are allowed (both JSON and PostgreSQL `items.sku`). The roadmap's CSV import plans upsert-by-SKU; that will need a unique index anyway, and OCR/barcode scanning is blocked without it. Add `UNIQUE INDEX items(sku) WHERE sku <> ''` + a pre-check message before shipping barcode workflows.

### D5 — "Today" boundaries are client-clock dependent
Frontend `metricsPeriod()` computes `todayFrom`/`todayTo` in the **browser's** local timezone and sends UTC instants; the server bucketizes its daily series in `America/Santiago` (`store.js`). If a cashier machine is not in Santiago time, the "today" summary/cash-close window can include/exclude an hour or two of sales differently from the daily buckets in the same report. In-bakery (Santiago) it's consistent; worth computing `todayFrom/todayTo` server-side from the configured `BAKERY_TIME_ZONE` instead of trusting the client.

### D6 — Loose ends that were probed and are fine
- Stock can never go below zero (400), either store.
- Card-sale reservation, cancel/expire/fail restore exactly once; duplicate webhook replay doesn't double-deduct (verified live).
- Refund pending → processed is idempotent; double-retry blocked; refunding an already-fully-refunded sale → 400; refunding non-paid sale → 409.
- Delete product blocked while a pending card sale references it (409), allowed after cancel, and the item is then unsellable; movement/sale snapshots retain the name (FKs → `ON DELETE SET NULL`).
- Cart: empty cart, >100 lines, quantity >10000, over-stock, ghost item, duplicate-line merging — all handled.
- Metrics require all six date params and a strict business date; >370 day window rejected; cash closure rejects negative opening; report HTML is escaped and self-contained.
- Sessions: 8-attempt lockout, expiry, forgery rejection, logout invalidation — all verified.
- UI: dashboard renders (es), zero console errors; full POS flow in a real browser: product → cart → Cobrar → Efectivo → "Pago aprobado", sale statuses render incl. `REEMBOLSADA`/`CANCELADA`.

---

## Hygiene / docs drift (no fixes made)

- **H1 — Retired pilot-receipt feature is still in the tree.** `server/pilot-receipt.js`, its 3 test files, `claimPilotReceiptPrint`/`completePilotReceiptPrint`/`failPilotReceiptPrint` in `store.js`, 8 `pilot_receipt_*` DB columns, 6 `pilotReceipt*` fields on every sale payload, `.env.example` `POINT_PILOT_*` vars, and 6 i18n keys (`pilotReceipt…`) remain after the README retired the feature. It's dormant (no routes call it; tests only test the module in isolation), but it's dead weight: DB columns, payload size, and test surface for a retired feature. Remove when convenient.
- **H2 — Docs/numbers drift:** README's Astryx "71.4 kB" figure doesn't match the current build (AstryxDeleteDialog chunk = 44.2 kB gzip JS + 26.4 kB gzip CSS); `index.html` `<title>Bakery Stock</title>` while the app brands itself "Bakery POS"; `SII_DTE_RESEARCH.md`/`ROADMAP.md` still describe the daily RVD obligation that `integración SII.md` itself corrects (the corrected doc flags this contradiction already — reconcile the older two).
- **H3 — The app interprets `NODE_ENV !== 'production'` as "not HTTPS".** Cookie `Secure` is tied to `NODE_ENV==='production' || RAILWAY_*`. Any non-Railway HTTPS host (revealed by the production webhook domain being Railway-generated, but the app is generic) won't flag cookies Secure unless `NODE_ENV` is set. Cheap fix: also set `Secure` when `proxy`/`X-Forwarded-Proto: https`, or document `NODE_ENV=production` as a required variable.
- **H4 — `tmp/` contains prior logs/JSON (codex, latency tests) and `scripts/*.py` + `Imagenes/` are untracked.** Not a bug — just confirming these predate my run; I added nothing and removed my scratch files.

---

## What is genuinely good

- The reservation/restore state machine (`inventory_applied` + row locks + `FOR UPDATE`) is the correct pattern for exactly-once inventory and it holds under replay.
- Refund idempotency (pending→processed guard, `mp_refund_id` dedupe, external-Point refund ingestion with explicit `inventoryReviewStatus`) is careful and validated by good tests.
- Validation density on the public surface is high; the error envelope is consistent (JSON, stable status codes).
- Password-like PIN handling (timing-safe compare, lockout, HTTP-only/SameSite cookies) is above average for a small internal tool.
- The **biggest gap** (SII/DTE issuance) is deliberately not implemented; docs correctly insist `received ≠ accepted`, credit notes are manual, and Point vouchers ≠ DTE. That restraint is the right call.

---

## Not covered (no DATABASE_URL / no live Mercado Pago available locally)

- PostgreSQL code paths (all `pool.query` branches) — the logic was reviewed line-by-line but only JSON mode was executed. Focus a future pass on: the raw-SQL `UNNEST` inserts, the `DO $$` constraint-migration block, and PG date binding for `expiry_date`.
- Live Point order/refund/webhook round-trips against a real terminal (tests cover the mock + HTTP-contract layer only).
- SII integration is design-only by scope (correctly).

---

## Verified checklist

| Check | Result |
| --- | --- |
| `npm run check` | ✅ pass |
| `npm test` (15 tests) | ✅ 15/15 |
| `npm run build` | ✅ pass |
| Server boot (JSON+seed, mock Point) | ✅ |
| GET /api/health, /api/pos/config, terminal, management | ✅ |
| Inventory CRUD + 8 validation rejects | ✅ |
| Cash sales (merge, overstock, ghost, caps) | ✅ |
| Card sale: reserve → refresh paid; webhook replay idempotent | ✅ |
| Card cancel → stock restored; double-cancel 409; delete-block 409 | ✅ |
| Refunds: partial/full, restock, over-amount, over-line rejects | ✅ (B2 gap found) |
| Credit note record + invalid doc-type reject | ✅ |
| Metrics ranges, cash closure, daily report HTML | ✅ |
| Auth: 401 unauth, lockout after 8, forged/expired/malformed cookies | ✅ except B1 |
| Browser POS flow (es) + zero console errors | ✅ |
