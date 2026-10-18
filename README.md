# Bakery POS

A responsive, touch-friendly bakery inventory and point-of-sale application. Spanish is the default language and English is available from the `ES / EN` control.

## Features

- Add and edit products, prices, sale availability, low-stock thresholds, SKUs, and expiry dates.
- Permanently remove discontinued products while retaining historical sales and activity.
- Record stock in, stock out, count corrections, and a complete movement trail.
- Build a cart from sellable products currently in stock.
- Record cash sales immediately.
- Send card sales to a Mercado Pago Point Smart 2 terminal.
- Keep sales, line-item price snapshots, payment state, and inventory changes in PostgreSQL.
- Restore reserved inventory exactly once when a card order fails, expires, or is cancelled.
- View recent sales and resume a pending terminal payment.
- Refund approved cash or Point sales in full or by selected line items.
- Optionally return refunded items to stock without duplicating inventory movements.
- Track pending and manually issued credit notes separately from the financial refund.
- Review revenue, payment mix, hourly demand, best sellers, and daily cash reconciliation.
- Export a lightweight, self-contained daily HTML report.
- Switch between a soft pastel light theme and a gray dark theme.
- Optional staff PIN protection with an HTTP-only session cookie.
- Responsive layouts for phones, desktops, and the 1024×768 Elo touchscreen.

## Run locally

Requirements: Node.js 20 or newer.

```bash
npm install
npm run build
npm start
```

Open `http://localhost:3000`. Without `DATABASE_URL`, data is stored in `data/inventory.json`.

### Product card photos

CAJA uses small WebP backgrounds for matching bakery products. The name-based mapping and crop areas are in `assets/pos-product-photos.json`; unmatched or failed images fall back to category icons. Product names, prices, and stock remain independent of the photos.

To regenerate after changing the source photos or mapping, run `python scripts/build-pos-product-photos.py` with Pillow installed, then `npm run build`. Commit the generated files in `src/assets/product-photos/`, `src/productPhotos.js`, and `assets/pos-product-photos-report.json`. The optimizer removes metadata, crops and resizes to 192×128 and 384×256, and selects WebP quality within 6 KiB and 16 KiB budgets. The browser chooses one size, lazy-loads the images, and reuses shared photos. Vite fingerprints them for immutable caching. The full-size `Imagenes/` originals are excluded from Railway deployments.

For a local Point simulation, set:

```text
SEED_DEMO_DATA=true
MERCADOPAGO_MOCK=true
```

The mock terminal approves a card sale after a short delay. Never set `MERCADOPAGO_MOCK=true` in production.

### Loading and request performance

The app starts with `/api/bootstrap`, which checks the staff session and returns inventory, recent movements, recent sales, and Point configuration together. Locked sessions receive only authentication status. This removes the previous authentication-then-four-requests waterfall. PostgreSQL reads run in parallel; local JSON mode reads and parses one snapshot instead of three. The endpoint exposes its data-loading duration in `Server-Timing`.

CAJA, metrics, and Point settings load as separate page modules. React and icons have stable, fingerprinted vendor bundles so ordinary application updates can reuse cached framework code. Product photos remain lazy-loaded and fingerprinted.

Concurrent GETs share one in-flight request. Sales polling revalidates its ETag every time; unchanged history returns `304` and reuses the existing array to avoid an unnecessary React render. Mutations and sign-out invalidate read state. Reads time out after 20 seconds, polling waits for the previous read to finish, and hidden tabs stop polling. Payment/refund writes are never automatically retried or coalesced. Metrics requests are cancelled when changing ranges or leaving the page, and date/currency formatters are reused per language.

Run `npm run measure:load` against a running local compiled app. Set `PRODUCTION_BASE_URL` and `STAFF_PIN` for authenticated production measurements; the script only reads application data and opens a staff session. Add `-- --legacy` to measure the former five-request startup flow. Results go to `output/performance.json` or `PERFORMANCE_OUTPUT`. The report counts all initial JavaScript, including preloaded vendors; gzip byte counts are estimates and timings use warm HTTP connections, not total browser page-load time.

`npm run audit:performance:db` accepts `DATABASE_PUBLIC_URL` or `DATABASE_URL` and runs SELECT/EXPLAIN queries inside a read-only transaction. It reports query plans and timings without changing stock or history.

### Railway CDN

Use Railway's CDN in Auto HTML mode with HTML purging after successful deployments. The shared app shell uses `public, max-age=0, s-maxage=60, stale-while-revalidate=300`: browsers revalidate, while edge locations can cache the shell briefly. The shell has no session or business data. `/index.html` has the same policy as `/`. Fingerprinted JavaScript, CSS, and WebP files use a one-year immutable cache and new URLs when their contents change.

Every `/api` response, including authentication, errors, and unknown routes, defaults to `private, no-store` with `Vary: Cookie`. Sales history permits private ETag revalidation while remaining excluded from shared caching. Missing assets return an uncached 404 instead of the HTML shell. Keep these boundaries when adding new endpoints.

Enable with `railway cdn enable --service stock-app`, then configure `railway cdn update --service stock-app --html-caching auto --default-ttl 2h --swr --purge-on-deploy html`. HTML purges preserve immutable assets at the edge. API requests continue to reach the server. CDN settings are service configuration, independent of Git deployments.

`npm run verify:cdn` checks live edge cache hits, deployed asset hashes, API exclusions, and (when `STAFF_PIN` is supplied) authenticated bootstrap/history. It only reads data and opens a staff session. Use `-- --baseline` for an uncached origin measurement: it deliberately sends `X-Railway-Debug`, which bypasses the CDN. Regular verification omits this header. Reports go to `output/cdn-before.json` or `output/cdn-after.json`, overridable with `CDN_OUTPUT`; `PRODUCTION_BASE_URL` selects a different host.

## Deploy to Railway

1. Deploy this GitHub repository as a Railway service.
2. Add PostgreSQL to the same Railway project.
3. In the app service, add `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
4. Add the security and Mercado Pago variables listed below.
5. Redeploy the app and generate a public domain.
6. Open `/api/health`; a healthy deployment returns `{ "ok": true }`.

Database tables and non-destructive schema additions are created automatically on startup.

To replace a connected PostgreSQL database with the generated one-week presentation dataset, run this only from an environment that supplies the intended `DATABASE_URL`:

```bash
npm run seed:week:postgres -- --yes --replace-production-demo
```

The command first copies all current application tables into timestamped tables under the `bakery_demo_backups` schema. It then loads products, sales, line items, inventory movements, and seven daily cash closures in one transaction. If generation, insertion, or verification fails, PostgreSQL rolls the replacement back.

## Point Smart 2 setup

This integration uses Mercado Pago's current Orders API for Point (`POST /v1/orders`), not the older payment-intents integration.

1. Create an application under **Your integrations** in Mercado Pago.
2. Link the Point Smart 2 to the same Mercado Pago account.
3. Create or select the physical store and point of sale.
4. Find the terminal ID using Mercado Pago's terminal list and associate the terminal with that point of sale.
5. Change the terminal operating mode to `PDV`, restart the terminal, and verify the pairing mode on the device.
6. Add the production Access Token and complete terminal ID to Railway.
7. In Mercado Pago Webhooks, set the production URL to:

   ```text
   https://YOUR-RAILWAY-DOMAIN/api/mercadopago/webhook
   ```

8. Select the **Order (Mercado Pago)** event and add the generated secret to Railway.
9. Redeploy, open **Ventas**, and tap the Point status control to verify that the terminal reports `PDV`.

Official references:

- [Mercado Pago Point overview](https://www.mercadopago.cl/developers/en/docs/mp-point/overview)
- [Configure the terminal](https://www.mercadopago.cl/developers/en/docs/mp-point/configure-terminal)
- [Integrate payment processing](https://www.mercadopago.cl/developers/en/docs/mp-point/payment-processing)
- [Configure Point order notifications](https://www.mercadopago.cl/developers/en/docs/mp-point/notifications)
- [Point integration testing](https://www.mercadopago.cl/developers/en/docs/mp-point/integration-test)

## Environment variables

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port; Railway supplies this automatically. |
| `DATABASE_URL` | PostgreSQL connection string. |
| `DATA_PATH` | JSON storage path when PostgreSQL is not configured. |
| `SEED_DEMO_DATA` | Set to `true` only for a new local demo database. |
| `STAFF_PIN` | Bakery staff access code. Required before live Point payments are enabled. |
| `SESSION_SECRET` | Long random value used to sign sessions. Required whenever `STAFF_PIN` is set. |
| `MERCADOPAGO_ACCESS_TOKEN` | Private production or test Access Token. Server-side only. |
| `MERCADOPAGO_POINT_TERMINAL_ID` | Full ID returned by Mercado Pago's terminal list. |
| `MERCADOPAGO_WEBHOOK_SECRET` | Secret generated by the Mercado Pago Webhooks configuration. |
| `MERCADOPAGO_MOCK` | Local-only Point simulator when set to `true`. |
| `MERCADOPAGO_API_BASE` | Optional API base override for controlled testing. |
| `PGSSLMODE` | Optional PostgreSQL SSL override. |

Never put Access Tokens, database passwords, PINs, or webhook secrets in GitHub. Store them as Railway variables.

### Point receipts

The experimental automatic custom sales receipt has been retired. Bakery POS no longer submits sale-receipt Printing API actions automatically or from Activity, and previous `POINT_PILOT_*` variables are ignored and can be removed from Railway. Card-payment orders use `print_on_terminal: seller_ticket`, so the Point terminal prints Mercado Pago's native seller voucher after an approved payment. This voucher is controlled by Mercado Pago; DTE issuance still depends on the tax configuration of the collecting Mercado Pago account until a certified tax provider is integrated.

Mercado Pago's public [refund endpoint](https://www.mercadopago.cl/developers/es/reference/in-person-payments/point/orders/refund-order/post) does not expose a native-voucher printing option, and the public [Printing API](https://www.mercadopago.cl/developers/es/reference/in-person-payments/point/impressions/create-terminal/post) accepts only developer-supplied custom content. For a processed card refund, Bakery POS therefore offers a manual **Print refund copy** action in the sale details. Each click creates one text-only Printing API job with no image and no automatic retry. The paper is explicitly labelled as a non-tax Bakery POS copy; it does not replace Mercado Pago's native refund voucher, a credit note, or a DTE.

## Payment and inventory behavior

Cash sales are committed in one database transaction. Card sales reserve inventory before sending the order to Point. The browser polls only while the checkout is open, and the webhook remains the authoritative asynchronous update path.

Point order status mapping:

| Mercado Pago order | Local sale | Inventory |
| --- | --- | --- |
| `created`, `at_terminal`, `action_required` | Pending | Remains reserved |
| `processed` + `accredited` | Paid | Reservation becomes the sale deduction |
| `failed`, `canceled`, `expired` | Final failure | Restored once |
| `processed` + `partially_refunded` | Paid with partial refund | Returned only when selected in the refund |
| `refunded` | Refunded | Returned only when selected in the refund |

A financial refund does not prove that physical products were returned or that a tax document was corrected. The refund flow therefore keeps stock restoration optional and tracks the SII credit note as a separate manual state until an automatic tax integration exists.

Planning and tax research:

- [Product roadmap](ROADMAP.md)
- [SII architecture summary](SII_DTE_RESEARCH.md)
- [Detailed SII integration analysis](integraci%C3%B3n%20SII.md)

## Commands

```bash
npm run check
npm test
npm run build
npm run audit:postgres
npm run smoke:production
npm run seed:week -- --yes
npm start
```

`seed:week` only replaces the local JSON demo. The PostgreSQL command is deliberately separate and requires the two explicit confirmation flags shown in the Railway section.

`audit:postgres` uses a read-only transaction to report database counts and integrity checks. It prefers `DATABASE_PUBLIC_URL` for local access. `smoke:production` uses `STAFF_PIN` to check the deployed API and Point terminal without creating sales or refunds. Set `EXPECT_AUTH_HARDENING=true` to require malformed cookies to return 401. Keep the local JSON demonstration dataset separate from the live PostgreSQL records.

The verified `ProductosPrecios` snapshot is in `assets/productos-precios.json`. `npm run import:catalog -- --target=local` previews its replacement of the local product catalog; add `--apply` to execute it. Use `--target=postgres` with the PoS production Postgres service variables for Railway. The import backs up the database, removes the previous products and stock movements, and loads the sheet's names and actual CLP prices with zero opening quantities. Sales, refund snapshots, tax documents and cash closures are retained; old product links are detached. The PostgreSQL replacement verifies history before committing and rolls back on failure.

Catalog source assets live in `Imagenes/`; the Python catalog/sign scripts use Pillow and ReportLab and write generated files under ignored `output/` and `tmp/` directories. `data/catalog_products.json` contains catalog source data and is separate from operational inventory.

## Production note

Keep staff authentication enabled on any public Railway deployment. This release provides one shared staff PIN; individual accounts, roles, approval limits, automatic tax issuance, and searchable long-term sales history remain necessary before a larger rollout.
