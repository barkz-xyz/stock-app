# Bakery POS Roadmap

Updated: 2026-10-31

This roadmap prioritizes operational correctness before adding breadth. Anything that moves money, stock, or tax documents must be auditable and idempotent.

## Now: returns and tax traceability

- [x] Cancel a pending Point order before payment is completed.
- [x] Refund an approved cash or Point sale, in full or by selected line items.
- [x] Use a stable idempotency key for Mercado Pago refunds.
- [x] Optionally return refunded items to inventory without duplicating stock movements.
- [x] Keep refund history and adjust sales metrics and cash closing by processed refunds.
- [x] Track a pending or manually issued credit note against its refund.
- [ ] Validate one low-value full refund and one partial refund with the physical Point Smart 2.
- [x] Search the complete sales and returns history by reference, date, payment method and status.

## Next: electronic receipts and SII

The target is an in-house DTE integration, not a screen-scraping automation.

- [ ] Confirm Atelier del Puerto's SII emission model and whether the Point payment voucher is configured to act as the electronic receipt.
- [ ] Obtain the taxpayer's digital certificate, certification access, and authorized folios (CAF).
- [ ] Build an isolated DTE service for certificate handling, XML generation, signing, folio allocation, submission, and status polling.
- [ ] Certify electronic receipts type 39 and, if needed, exempt receipts type 41.
- [ ] Certify electronic credit notes type 61 and link them to the original receipt or invoice.
- [ ] Support the RCF/RVD artifact only if the active SII certification test set requests it; do not schedule a production daily-summary job because that obligation ended in August 2022.
- [ ] Add delivery of the receipt by print, email, or QR and retain the accepted XML plus its audit trail.
- [ ] Add retry queues and operational alerts for rejected, delayed, or exhausted-folio documents.

Historical architecture, regulatory and economic research is consolidated in [the SII research document](docs/research/sii-integration.md). Revalidate its dated findings before implementation; tax issuance remains separate from the POS.

## Product import

- [ ] Import products from CSV.
- [ ] Import products from Excel (`.xlsx`) after the CSV mapping is stable.
- [ ] Preview and validate rows before writing anything.
- [ ] Map columns for SKU, barcode, name, price, cost, category, unit, stock, and low-stock threshold.
- [ ] Support upsert by SKU or barcode and produce a downloadable error report.
- [ ] Make imports idempotent so uploading the same file cannot duplicate products.

## Multi-company and multi-branch

- [ ] Introduce `organization_id` and `branch_id` ownership on every operational table.
- [ ] Enforce tenant isolation in database queries, sessions, exports, files, and background jobs.
- [ ] Add users, roles, and branch-scoped permissions.
- [ ] Keep separate Point terminals, SII credentials, folio ranges, time zones, and cash registers per branch.
- [ ] Add consolidated owner reporting without exposing one company's data to another.
- [ ] Add automated isolation tests before offering the product as SaaS.

This is viable, but it is a structural migration rather than a settings screen. It should happen before onboarding a second paying business, not after.

## Suppliers and purchasing

Deferred until sales, returns, and tax issuance are stable.

- [ ] Suppliers and contacts.
- [ ] Product cost and cost history.
- [ ] Purchase orders with draft, sent, partial, and received states.
- [ ] Stock reception against purchase-order lines.
- [ ] Accounts payable references and supplier invoice attachment.
- [ ] Gross margin and waste reporting based on real costs.

## General POS capabilities

- [ ] Barcode scanning from the Elo computer and supported Point/SmartApps surfaces.
- [ ] Discounts, promotions, and price lists with permission controls.
- [x] Cashier shifts, register opening, withdrawals, and versioned close history.
- [ ] Customer records only where they provide a clear operational or tax benefit.
- [ ] Receipt lookup by sale ID, Point order, barcode, date, amount, or cashier.
- [ ] Offline continuity for cash sales with an explicit synchronization queue.
- [ ] Automated PostgreSQL backups, restore drills, monitoring, and audit-log retention.
- [ ] Role-based approvals for refunds, stock corrections, discounts, and credit notes.

## Release gates

A feature that affects payments, stock, or DTEs is complete only when it has:

1. Server-side validation and idempotency.
2. An immutable or append-only audit record.
3. Automated tests for success, retry, and failure paths.
4. Responsive light and dark interfaces in Spanish and English.
5. A rollback or reconciliation procedure for external-service failures.
