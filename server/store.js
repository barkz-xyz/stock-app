import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { dateOnly } from '../src/dates.js'
import { publishChange } from './changes.js'
import { cleanInventoryBatch, inventoryBatchChanges } from './inventory-batch.js'
import { cleanHistoryQuery, historyMatches } from './sales-history.js'
import { publicUser, cleanUser, hashPassword, userError } from './user-security.js'
import { initializeCashLedger, cashAmount, withCashLedger } from './cash-ledger.js'
import { createRegisterCashStore } from './register-cash-store.js'
import { createIntegrationStore } from './integration-store.js'
import { initializeInventoryRevision, readInventorySnapshot } from './inventory-snapshot.js'
import { initializeStockReservations, createStockReservationStore, assertNoStockHolds } from './stock-reservations.js'
import { closurePeriod, buildClosureSummary, cleanClosureInput, createClosure, closureError, businessDateAt } from './cash-closure.js'

const { Pool } = pg
const databaseUrl = process.env.DATABASE_URL
const dataPath = process.env.DATA_PATH || path.join(process.cwd(), 'data', 'inventory.json')
let pool = null
let fileQueue = Promise.resolve()

const demoItems = [
  { name: 'Butter croissant', category: 'Pastries', unit: 'pieces', quantity: 28, lowStockThreshold: 10, sku: 'PAS-001', expiryDate: tomorrow(1), price: 1800, sellable: true },
  { name: 'Sourdough loaf', category: 'Bread', unit: 'loaves', quantity: 8, lowStockThreshold: 8, sku: 'BRD-001', expiryDate: tomorrow(2), price: 4200, sellable: true },
  { name: 'Chocolate éclair', category: 'Pastries', unit: 'pieces', quantity: 5, lowStockThreshold: 8, sku: 'PAS-004', expiryDate: tomorrow(1), price: 2200, sellable: true },
  { name: 'All-purpose flour', category: 'Ingredients', unit: 'kg', quantity: 42, lowStockThreshold: 15, sku: 'ING-001', expiryDate: tomorrow(90), price: 0, sellable: false },
  { name: 'Cake boxes', category: 'Packaging', unit: 'boxes', quantity: 12, lowStockThreshold: 20, sku: 'PKG-003', expiryDate: null, price: 0, sellable: false },
]

function tomorrow(days) {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}

function shortId(id) {
  return id.replaceAll('-', '').slice(0, 8).toUpperCase()
}

function saleExternalReference(id) {
  return `VENTA-${id.replaceAll('-', '').slice(0, 12).toUpperCase()}`
}

function normalizeItem(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    unit: row.unit,
    quantity: Number(row.quantity),
    lowStockThreshold: Number(row.low_stock_threshold ?? row.lowStockThreshold ?? 0),
    sku: row.sku || '',
    expiryDate: dateOnly(row.expiry_date ?? row.expiryDate),
    price: Number(row.price || 0),
    sellable: Boolean(row.sellable),
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
  }
}

function normalizeMovement(row) {
  return {
    id: row.id,
    itemId: row.item_id ?? row.itemId,
    itemName: row.item_name ?? row.itemName,
    saleId: row.sale_id ?? row.saleId ?? null,
    reservationId: row.reservation_id ?? row.reservationId ?? null,
    type: row.type,
    quantity: Number(row.quantity),
    balanceAfter: Number(row.balance_after ?? row.balanceAfter),
    note: row.note || '',
    createdAt: row.created_at ?? row.createdAt,
  }
}

function normalizeCreditNote(row) {
  if (!row) return null
  return {
    id: row.id,
    status: row.status,
    mode: row.mode || 'manual',
    originalDocumentType: row.original_document_type ?? row.originalDocumentType ?? '',
    originalFolio: row.original_folio ?? row.originalFolio ?? '',
    folio: row.folio || '',
    siiTrackId: row.sii_track_id ?? row.siiTrackId ?? '',
    errorDetail: row.error_detail ?? row.errorDetail ?? '',
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
    issuedAt: row.issued_at ?? row.issuedAt ?? null,
  }
}

function normalizeRefund(row, items = row.items || [], creditNote = row.creditNote || row.credit_note || null) {
  return {
    id: row.id,
    saleId: row.sale_id ?? row.saleId,
    status: row.status,
    amount: Number(row.amount),
    reason: row.reason || '',
    restock: Boolean(row.restock),
    creditNoteRequired: Boolean(row.credit_note_required ?? row.creditNoteRequired),
    originalDocumentType: row.original_document_type ?? row.originalDocumentType ?? '',
    originalFolio: row.original_folio ?? row.originalFolio ?? '',
    mpRefundId: row.mp_refund_id ?? row.mpRefundId ?? null,
    mpReferenceId: row.mp_reference_id ?? row.mpReferenceId ?? null,
    mpStatus: row.mp_status ?? row.mpStatus ?? null,
    source: row.source || 'pos',
    inventoryReviewStatus: row.inventory_review_status ?? row.inventoryReviewStatus ?? 'resolved',
    errorDetail: row.error_detail ?? row.errorDetail ?? '',
    items: items.map((item) => ({
      lineId: item.sale_item_id ?? item.lineId,
      itemId: item.item_id ?? item.itemId ?? null,
      name: item.item_name ?? item.name,
      quantity: Number(item.quantity),
      unitPrice: Number(item.unit_price ?? item.unitPrice),
      lineTotal: Number(item.line_total ?? item.lineTotal),
      restocked: Boolean(item.restocked),
    })),
    creditNote: normalizeCreditNote(creditNote),
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
    processedAt: row.processed_at ?? row.processedAt ?? null,
  }
}

function normalizeSale(row, items = row.items || [], refunds = row.refunds || []) {
  const normalizedRefunds = refunds.map((refund) => normalizeRefund(refund, refund.items, refund.creditNote || refund.credit_note))
  const refundedTotal = normalizedRefunds
    .filter((refund) => refund.status === 'processed')
    .reduce((sum, refund) => sum + refund.amount, 0)
  return {
    id: row.id,
    shortId: shortId(row.id),
    checkoutKey: row.checkout_key ?? row.checkoutKey ?? null,
    status: row.status,
    paymentMethod: row.payment_method ?? row.paymentMethod,
    total: Number(row.total),
    cashReceived: row.cash_received == null && row.cashReceived == null ? null : Number(row.cash_received ?? row.cashReceived),
    cashChange: row.cash_received == null && row.cashReceived == null ? null : Number(row.cash_received ?? row.cashReceived) - Number(row.total),
    cashierId: row.cashier_id ?? row.cashierId ?? null,
    cashierName: row.cashier_name ?? row.cashierName ?? '',
    registerSessionId: row.register_session_id ?? row.registerSessionId ?? null,
    items: items.map((item) => ({
      lineId: item.id ?? item.line_id ?? item.lineId,
      itemId: item.item_id ?? item.itemId,
      name: item.item_name ?? item.name,
      unit: item.unit,
      quantity: Number(item.quantity),
      inventoryQuantity: Number(item.inventory_quantity ?? item.inventoryQuantity ?? item.quantity),
      unstockedQuantity: Math.round((Number(item.quantity) - Number(item.inventory_quantity ?? item.inventoryQuantity ?? item.quantity)) * 100) / 100,
      unitPrice: Number(item.unit_price ?? item.unitPrice),
      lineTotal: Number(item.line_total ?? item.lineTotal),
    })),
    refunds: normalizedRefunds,
    refundedTotal,
    refundableTotal: Math.max(Number(row.total) - refundedTotal, 0),
    mpOrderId: row.mp_order_id ?? row.mpOrderId ?? null,
    mpPaymentId: row.mp_payment_id ?? row.mpPaymentId ?? null,
    mpExternalReference: row.mp_external_reference ?? row.mpExternalReference ?? saleExternalReference(row.id),
    mpOperationId: row.mp_operation_id ?? row.mpOperationId ?? null,
    mpAuthorizationCode: row.mp_authorization_code ?? row.mpAuthorizationCode ?? '',
    mpCardBrand: row.mp_card_brand ?? row.mpCardBrand ?? '',
    mpCardLastFour: row.mp_card_last_four ?? row.mpCardLastFour ?? '',
    mpPaymentType: row.mp_payment_type ?? row.mpPaymentType ?? '',
    mpFeeAmount: Number(row.mp_fee_amount ?? row.mpFeeAmount ?? 0),
    mpNetReceivedAmount: row.mp_net_received_amount == null && row.mpNetReceivedAmount == null
      ? null : Number(row.mp_net_received_amount ?? row.mpNetReceivedAmount),
    mpTerminalSerial: row.mp_terminal_serial ?? row.mpTerminalSerial ?? '',
    mpTaxSetting: row.mp_tax_setting ?? row.mpTaxSetting ?? '',
    mpReconciledAt: row.mp_reconciled_at ?? row.mpReconciledAt ?? null,
    pilotReceiptStatus: row.pilot_receipt_status ?? row.pilotReceiptStatus ?? 'not_requested',
    pilotReceiptActionId: row.pilot_receipt_action_id ?? row.pilotReceiptActionId ?? null,
    pilotReceiptError: row.pilot_receipt_error ?? row.pilotReceiptError ?? '',
    pilotReceiptPrintedAt: row.pilot_receipt_printed_at ?? row.pilotReceiptPrintedAt ?? null,
    mpStatus: row.mp_status ?? row.mpStatus ?? null,
    mpStatusDetail: row.mp_status_detail ?? row.mpStatusDetail ?? null,
    inventoryApplied: Boolean(row.inventory_applied ?? row.inventoryApplied),
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
    paidAt: row.paid_at ?? row.paidAt ?? null,
  }
}

function normalizeCashClosure(row) {
  if (!row) return null
  return {
    id: row.id,
    businessDate: dateOnly(row.business_date ?? row.businessDate),
    openingCash: Number(row.opening_cash ?? row.openingCash ?? 0),
    cashAdjustments: Number(row.cash_adjustments ?? row.cashAdjustments ?? 0),
    countedCash: Number(row.counted_cash ?? row.countedCash ?? 0),
    cashSales: Number(row.cash_sales ?? row.cashSales ?? 0),
    cardSales: Number(row.card_sales ?? row.cardSales ?? 0),
    totalSales: Number(row.total_sales ?? row.totalSales ?? 0),
    expectedCash: Number(row.expected_cash ?? row.expectedCash ?? 0),
    difference: Number(row.difference ?? 0),
    transactionCount: Number(row.transaction_count ?? row.transactionCount ?? 0),
    note: row.note || '',
    closedAt: row.closed_at ?? row.closedAt,
    revision: 1,
    ...(row.details?.current || row.snapshot && row || {}),
    history: row.details?.history || row.history || [],
  }
}

function ensureFileShape(data) {
  data.items ||= []
  data.movements ||= []
  data.sales ||= []
  data.cashClosures ||= []
  data.stockBatches ||= []
  data.users ||= []; data.authSessions ||= []; data.registerSessions ||= []
  data.cashWithdrawals ||= []; data.cashEntries ||= []; data.cashOperations ||= []
  for (const item of data.items) {
    item.price = Number(item.price || 0)
    item.sellable = Boolean(item.sellable)
  }
  for (const sale of data.sales) {
    sale.refunds ||= []
    sale.mpExternalReference ||= saleExternalReference(sale.id)
    sale.mpFeeAmount = Number(sale.mpFeeAmount || 0)
    for (const line of sale.items || []) line.lineId ||= crypto.randomUUID()
    for (const refund of sale.refunds) {
      refund.items ||= []
      refund.creditNote ||= null
      refund.source ||= 'pos'
      refund.inventoryReviewStatus ||= 'resolved'
    }
  }
  return data
}

export async function initializeStore() {
  if (databaseUrl) {
    const useSsl = !databaseUrl.includes('railway.internal') && process.env.PGSSLMODE !== 'disable'
    pool = new Pool({ connectionString: databaseUrl, ssl: useSsl ? { rejectUnauthorized: false } : false })
    await pool.query(`
      CREATE TABLE IF NOT EXISTS items (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        unit TEXT NOT NULL,
        quantity NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
        low_stock_threshold NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (low_stock_threshold >= 0),
        sku TEXT NOT NULL DEFAULT '',
        expiry_date DATE,
        price NUMERIC(12,0) NOT NULL DEFAULT 0 CHECK (price >= 0),
        sellable BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE items ADD COLUMN IF NOT EXISTS price NUMERIC(12,0) NOT NULL DEFAULT 0 CHECK (price >= 0);
      ALTER TABLE items ADD COLUMN IF NOT EXISTS sellable BOOLEAN NOT NULL DEFAULT FALSE;

      CREATE TABLE IF NOT EXISTS sales (
        id UUID PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('pending','paid','failed','cancelled','expired','refunded')),
        payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','card')),
        total NUMERIC(12,0) NOT NULL CHECK (total >= 0),
        mp_order_id TEXT UNIQUE,
        mp_payment_id TEXT,
        mp_status TEXT,
        mp_status_detail TEXT,
        mp_external_reference TEXT UNIQUE,
        mp_operation_id TEXT,
        mp_authorization_code TEXT NOT NULL DEFAULT '',
        mp_card_brand TEXT NOT NULL DEFAULT '',
        mp_card_last_four TEXT NOT NULL DEFAULT '',
        mp_payment_type TEXT NOT NULL DEFAULT '',
        mp_fee_amount NUMERIC(12,0) NOT NULL DEFAULT 0,
        mp_net_received_amount NUMERIC(12,0),
        mp_terminal_serial TEXT NOT NULL DEFAULT '',
        mp_tax_setting TEXT NOT NULL DEFAULT '',
        mp_reconciled_at TIMESTAMPTZ,
        pilot_receipt_status TEXT NOT NULL DEFAULT 'not_requested',
        pilot_receipt_action_id TEXT,
        pilot_receipt_error TEXT NOT NULL DEFAULT '',
        pilot_receipt_printed_at TIMESTAMPTZ,
        inventory_applied BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        paid_at TIMESTAMPTZ
      );
      ALTER TABLE sales ADD COLUMN IF NOT EXISTS checkout_key UUID;
      ALTER TABLE sales ADD COLUMN IF NOT EXISTS cashier_id UUID;
      ALTER TABLE sales ADD COLUMN IF NOT EXISTS cashier_name TEXT NOT NULL DEFAULT '';
      ALTER TABLE sales ADD COLUMN IF NOT EXISTS register_session_id UUID;
      CREATE INDEX IF NOT EXISTS sales_cashier_session_idx ON sales(cashier_id,register_session_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS app_users (
        id UUID PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','cashier')), active BOOLEAN NOT NULL DEFAULT TRUE,
        password_hash TEXT NOT NULL, must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY, user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS register_sessions (
        id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES app_users(id), operator TEXT NOT NULL,
        opening_cash NUMERIC(12,0) NOT NULL CHECK(opening_cash>=0), opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        closed_at TIMESTAMPTZ, closure JSONB
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_register_per_user ON register_sessions(user_id) WHERE closed_at IS NULL;
      ALTER TABLE sales ADD COLUMN IF NOT EXISTS cash_received NUMERIC(12,0) CHECK (cash_received IS NULL OR (payment_method='cash' AND cash_received >= total));
      CREATE TABLE IF NOT EXISTS stock_batches (
        id UUID PRIMARY KEY, fingerprint TEXT NOT NULL, result JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE sales ADD COLUMN IF NOT EXISTS checkout_fingerprint TEXT;
      ALTER TABLE sales ADD COLUMN IF NOT EXISTS point_order_lease_until TIMESTAMPTZ;
      CREATE UNIQUE INDEX IF NOT EXISTS sales_checkout_key_idx ON sales(checkout_key);
      CREATE TABLE IF NOT EXISTS sale_items (
        id UUID PRIMARY KEY,
        sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
        item_id UUID REFERENCES items(id) ON DELETE SET NULL,
        item_name TEXT NOT NULL,
        unit TEXT NOT NULL,
        quantity NUMERIC(12,2) NOT NULL CHECK (quantity > 0),
        unit_price NUMERIC(12,0) NOT NULL CHECK (unit_price >= 0),
        line_total NUMERIC(12,0) NOT NULL CHECK (line_total >= 0)
      );
      ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS inventory_quantity NUMERIC(12,2)
        CHECK(inventory_quantity >= 0 AND inventory_quantity <= quantity);
      CREATE TABLE IF NOT EXISTS refunds (
        id UUID PRIMARY KEY,
        sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('pending','processed','failed')),
        amount NUMERIC(12,0) NOT NULL CHECK (amount > 0),
        reason TEXT NOT NULL DEFAULT '',
        restock BOOLEAN NOT NULL DEFAULT TRUE,
        credit_note_required BOOLEAN NOT NULL DEFAULT FALSE,
        original_document_type TEXT NOT NULL DEFAULT '',
        original_folio TEXT NOT NULL DEFAULT '',
        mp_refund_id TEXT UNIQUE,
        mp_reference_id TEXT,
        mp_status TEXT,
        source TEXT NOT NULL DEFAULT 'pos',
        inventory_review_status TEXT NOT NULL DEFAULT 'resolved',
        error_detail TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS refund_items (
        id UUID PRIMARY KEY,
        refund_id UUID NOT NULL REFERENCES refunds(id) ON DELETE CASCADE,
        sale_item_id UUID REFERENCES sale_items(id) ON DELETE SET NULL,
        item_id UUID REFERENCES items(id) ON DELETE SET NULL,
        item_name TEXT NOT NULL,
        quantity NUMERIC(12,2) NOT NULL CHECK (quantity > 0),
        unit_price NUMERIC(12,0) NOT NULL CHECK (unit_price >= 0),
        line_total NUMERIC(12,0) NOT NULL CHECK (line_total >= 0),
        restocked BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE TABLE IF NOT EXISTS tax_documents (
        id UUID PRIMARY KEY,
        sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
        refund_id UUID NOT NULL UNIQUE REFERENCES refunds(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('credit_note')),
        status TEXT NOT NULL CHECK (status IN ('pending','issued','failed')),
        mode TEXT NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual','sii_own')),
        original_document_type TEXT NOT NULL DEFAULT '',
        original_folio TEXT NOT NULL DEFAULT '',
        folio TEXT NOT NULL DEFAULT '',
        sii_track_id TEXT NOT NULL DEFAULT '',
        error_detail TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        issued_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS movements (
        id UUID PRIMARY KEY,
        item_id UUID REFERENCES items(id) ON DELETE SET NULL,
        item_name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('stock_in', 'stock_out', 'adjustment')),
        quantity NUMERIC(12,2) NOT NULL,
        balance_after NUMERIC(12,2) NOT NULL CHECK (balance_after >= 0),
        note TEXT NOT NULL DEFAULT '',
        sale_id UUID REFERENCES sales(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS cash_closures (
        id UUID PRIMARY KEY,
        business_date DATE NOT NULL UNIQUE,
        opening_cash NUMERIC(12,0) NOT NULL DEFAULT 0 CHECK (opening_cash >= 0),
        cash_adjustments NUMERIC(12,0) NOT NULL DEFAULT 0,
        counted_cash NUMERIC(12,0) NOT NULL DEFAULT 0 CHECK (counted_cash >= 0),
        cash_sales NUMERIC(12,0) NOT NULL DEFAULT 0 CHECK (cash_sales >= 0),
        card_sales NUMERIC(12,0) NOT NULL DEFAULT 0 CHECK (card_sales >= 0),
        total_sales NUMERIC(12,0) NOT NULL DEFAULT 0 CHECK (total_sales >= 0),
        expected_cash NUMERIC(12,0) NOT NULL DEFAULT 0,
        difference NUMERIC(12,0) NOT NULL DEFAULT 0,
        transaction_count INTEGER NOT NULL DEFAULT 0 CHECK (transaction_count >= 0),
        note TEXT NOT NULL DEFAULT '',
        closed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE cash_closures ADD COLUMN IF NOT EXISTS details JSONB;
      ALTER TABLE cash_closures DROP CONSTRAINT IF EXISTS cash_closures_cash_sales_check;
      ALTER TABLE cash_closures DROP CONSTRAINT IF EXISTS cash_closures_card_sales_check;
      ALTER TABLE cash_closures DROP CONSTRAINT IF EXISTS cash_closures_total_sales_check;
      ALTER TABLE movements ADD COLUMN IF NOT EXISTS sale_id UUID REFERENCES sales(id) ON DELETE SET NULL;
      ALTER TABLE sales ADD COLUMN IF NOT EXISTS mp_external_reference TEXT;
      ALTER TABLE sales ADD COLUMN IF NOT EXISTS mp_operation_id TEXT;
      ALTER TABLE sales ADD COLUMN IF NOT EXISTS mp_authorization_code TEXT NOT NULL DEFAULT '';
      ALTER TABLE sales ADD COLUMN IF NOT EXISTS mp_card_brand TEXT NOT NULL DEFAULT '';
      ALTER TABLE sales ADD COLUMN IF NOT EXISTS mp_card_last_four TEXT NOT NULL DEFAULT '';
      ALTER TABLE sales ADD COLUMN IF NOT EXISTS mp_payment_type TEXT NOT NULL DEFAULT '';
      ALTER TABLE sales ADD COLUMN IF NOT EXISTS mp_fee_amount NUMERIC(12,0) NOT NULL DEFAULT 0;
      ALTER TABLE sales ADD COLUMN IF NOT EXISTS mp_net_received_amount NUMERIC(12,0);
      ALTER TABLE sales ADD COLUMN IF NOT EXISTS mp_terminal_serial TEXT NOT NULL DEFAULT '';
      ALTER TABLE sales ADD COLUMN IF NOT EXISTS mp_tax_setting TEXT NOT NULL DEFAULT '';
      ALTER TABLE sales ADD COLUMN IF NOT EXISTS mp_reconciled_at TIMESTAMPTZ;
      ALTER TABLE sales ADD COLUMN IF NOT EXISTS pilot_receipt_status TEXT NOT NULL DEFAULT 'not_requested';
      ALTER TABLE sales ADD COLUMN IF NOT EXISTS pilot_receipt_action_id TEXT;
      ALTER TABLE sales ADD COLUMN IF NOT EXISTS pilot_receipt_error TEXT NOT NULL DEFAULT '';
      ALTER TABLE sales ADD COLUMN IF NOT EXISTS pilot_receipt_printed_at TIMESTAMPTZ;
      ALTER TABLE refunds ADD COLUMN IF NOT EXISTS mp_reference_id TEXT;
      ALTER TABLE refunds ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'pos';
      ALTER TABLE refunds ADD COLUMN IF NOT EXISTS inventory_review_status TEXT NOT NULL DEFAULT 'resolved';
      UPDATE sales SET mp_external_reference=CONCAT('VENTA-', UPPER(LEFT(REPLACE(id::text, '-', ''), 12))) WHERE mp_external_reference IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS sales_mp_external_reference_idx ON sales(mp_external_reference);
      ALTER TABLE sale_items ALTER COLUMN item_id DROP NOT NULL;
      ALTER TABLE movements ALTER COLUMN item_id DROP NOT NULL;
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'sale_items'::regclass AND conname = 'sale_items_item_id_fkey' AND confdeltype <> 'n'
        ) THEN
          ALTER TABLE sale_items DROP CONSTRAINT sale_items_item_id_fkey;
          ALTER TABLE sale_items ADD CONSTRAINT sale_items_item_id_fkey FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE SET NULL;
        END IF;
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'movements'::regclass AND conname = 'movements_item_id_fkey' AND confdeltype <> 'n'
        ) THEN
          ALTER TABLE movements DROP CONSTRAINT movements_item_id_fkey;
          ALTER TABLE movements ADD CONSTRAINT movements_item_id_fkey FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE SET NULL;
        END IF;
      END $$;
      CREATE INDEX IF NOT EXISTS movements_created_at_idx ON movements(created_at DESC);
      CREATE INDEX IF NOT EXISTS sales_created_at_idx ON sales(created_at DESC);
      CREATE INDEX IF NOT EXISTS sales_mp_order_id_idx ON sales(mp_order_id);
      CREATE INDEX IF NOT EXISTS sale_items_sale_id_idx ON sale_items(sale_id);
      CREATE INDEX IF NOT EXISTS refunds_sale_id_idx ON refunds(sale_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS refund_items_refund_id_idx ON refund_items(refund_id);
      CREATE INDEX IF NOT EXISTS tax_documents_sale_id_idx ON tax_documents(sale_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS cash_closures_business_date_idx ON cash_closures(business_date DESC);
      CREATE OR REPLACE FUNCTION bakery_notify_change() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_notify('bakery_changes', 'changed');
        RETURN NULL;
      END $$;
      DO $$ DECLARE target TEXT; BEGIN
        FOREACH target IN ARRAY ARRAY['items','sales','sale_items','refunds','refund_items','tax_documents','movements','cash_closures'] LOOP
          IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(target) AND tgname='bakery_changed') THEN
            EXECUTE format('CREATE TRIGGER bakery_changed AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION bakery_notify_change()', target);
          END IF;
        END LOOP;
      END $$;
    `)
    await initializeInventoryRevision(pool)
    await initializeStockReservations(pool)
    await initializeCashLedger(pool)
    await seedInitialAdmin()
    return
  }

  await fs.mkdir(path.dirname(dataPath), { recursive: true })
  try {
    await fs.access(dataPath)
    const data = ensureFileShape(await readFileData())
    await writeFileData(data)
  } catch (error) {
    if(error.code!=='ENOENT')throw error
    const data = { items: [], movements: [], sales: [], cashClosures: [] }
    if (process.env.SEED_DEMO_DATA === 'true') {
      for (const item of demoItems) addItemToData(data, item)
    }
    await writeFileData(data)
  }
  await seedInitialAdmin()
}

async function readFileData() {
  return ensureFileShape(JSON.parse(await fs.readFile(dataPath, 'utf8')))
}
async function writeFileData(data) {
  const temporary=`${dataPath}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temporary,JSON.stringify(data,null,2))
  for(let attempt=0;;attempt++){
    try {await fs.rename(temporary,dataPath);break}
    catch(error){if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=12)throw error;await new Promise(resolve=>setTimeout(resolve,10*(attempt+1)))}
  }
}

function mutateFileData(callback) {
  const operation = fileQueue.then(async () => {
    const data = await readFileData()
    const result = await callback(data)
    await writeFileData(data)
    publishChange()
    return result
  })
  fileQueue = operation.catch(() => {})
  return operation
}

function addItemToData(data, input) {
  const now = new Date().toISOString()
  const item = {
    id: crypto.randomUUID(),
    name: input.name,
    category: input.category,
    unit: input.unit,
    quantity: Number(input.quantity || 0),
    lowStockThreshold: Number(input.lowStockThreshold || 0),
    sku: input.sku || '',
    expiryDate: input.expiryDate || null,
    price: Number(input.price || 0),
    sellable: Boolean(input.sellable),
    createdAt: now,
    updatedAt: now,
  }
  data.items.push(item)
  if (item.quantity > 0) {
    data.movements.unshift({
      id: crypto.randomUUID(), itemId: item.id, itemName: item.name, saleId: null, type: 'stock_in',
      quantity: item.quantity, balanceAfter: item.quantity, note: 'Opening stock', createdAt: now,
    })
  }
  return item
}

export async function listItems() {
  if (pool) {
    const { rows } = await pool.query('SELECT * FROM items ORDER BY name ASC')
    return rows.map(normalizeItem)
  }
  const data = await readFileData()
  return data.items.sort((a, b) => a.name.localeCompare(b.name)).map(normalizeItem)
}

export function getInventoryIntegrationStore() {
  return createIntegrationStore({ pool, dataPath,
    readInventorySnapshot: pool ? (revision, itemId) => readInventorySnapshot(pool, revision, itemId) : undefined,
    readInventory: async itemId => {
    if (pool) {
      const fields = 'id,sku,name,category,unit,quantity,price,sellable,expiry_date,updated_at'
      const { rows } = await pool.query(itemId
        ? `SELECT ${fields} FROM items WHERE id=$1 ORDER BY id`
        : `SELECT ${fields} FROM items ORDER BY id`, itemId ? [itemId] : [])
      return rows
    }
    const data = await readFileData()
    return itemId ? data.items.filter(item => item.id.toLowerCase() === itemId.toLowerCase()) : data.items
  } })
}

export function getStockReservationStore(options = {}) {
  return createStockReservationStore({ pool, ...options })
}

export async function getBootstrapData(now = new Date()) {
  if (pool) {
    const [items, movements, sales, dailySummary] = await Promise.all([listItems(), listMovements(100), listSales(50), getDailySummary(now)])
    return { items, movements, sales, dailySummary }
  }
  // Local mode needs one JSON read/parse for the whole snapshot, not three.
  const data = await readFileData()
  return {
    items: data.items.sort((a, b) => a.name.localeCompare(b.name)).map(normalizeItem),
    movements: data.movements.slice(0, 100).map(normalizeMovement),
    sales: data.sales.slice(0, 50).map(sale => normalizeSale(sale)),
    dailySummary: summarizeDay(data, now),
  }
}

export async function createItem(input) {
  if (!pool) return mutateFileData((data) => addItemToData(data, input))

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const id = crypto.randomUUID()
    const { rows } = await client.query(
      `INSERT INTO items (id, name, category, unit, quantity, low_stock_threshold, sku, expiry_date, price, sellable)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id, input.name, input.category, input.unit, input.quantity, input.lowStockThreshold, input.sku, input.expiryDate || null, input.price, input.sellable],
    )
    if (Number(input.quantity) > 0) {
      await client.query(
        `INSERT INTO movements (id, item_id, item_name, type, quantity, balance_after, note)
         VALUES ($1,$2,$3,'stock_in',$4,$4,'Opening stock')`,
        [crypto.randomUUID(), id, input.name, input.quantity],
      )
    }
    await client.query('COMMIT')
    return normalizeItem(rows[0])
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function updateItem(id, input) {
  if (!pool) {
    return mutateFileData((data) => {
      const item = data.items.find((entry) => entry.id === id)
      if (!item) return null
      Object.assign(item, input, { updatedAt: new Date().toISOString() })
      return normalizeItem(item)
    })
  }
  const { rows } = await pool.query(
    `UPDATE items SET name=$2, category=$3, unit=$4, low_stock_threshold=$5, sku=$6,
     expiry_date=$7, price=$8, sellable=$9, updated_at=NOW() WHERE id=$1 RETURNING *`,
    [id, input.name, input.category, input.unit, input.lowStockThreshold, input.sku, input.expiryDate || null, input.price, input.sellable],
  )
  return rows[0] ? normalizeItem(rows[0]) : null
}

export async function deleteItem(id) {
  if (!pool) {
    return mutateFileData((data) => {
      const index = data.items.findIndex((entry) => entry.id === id)
      if (index === -1) return null
      const pendingSale = data.sales.some((sale) => sale.status === 'pending' && sale.items.some((line) => line.itemId === id))
      if (pendingSale) throw Object.assign(new Error('This product is reserved by a pending card sale and cannot be deleted yet.'), { status: 409 })
      const [item] = data.items.splice(index, 1)
      for (const movement of data.movements) if (movement.itemId === id) movement.itemId = null
      for (const sale of data.sales) {
        for (const line of sale.items) if (line.itemId === id) line.itemId = null
      }
      return normalizeItem(item)
    })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const itemResult = await client.query('SELECT * FROM items WHERE id=$1 FOR UPDATE', [id])
    if (!itemResult.rows[0]) {
      await client.query('ROLLBACK')
      return null
    }
    const pendingResult = await client.query(
      `SELECT 1 FROM sale_items si JOIN sales s ON s.id=si.sale_id
       WHERE si.item_id=$1 AND s.status='pending' LIMIT 1`,
      [id],
    )
    if (pendingResult.rows[0]) {
      throw Object.assign(new Error('This product is reserved by a pending card sale and cannot be deleted yet.'), { status: 409 })
    }
    await assertNoStockHolds(client, [id])
    await client.query('DELETE FROM items WHERE id=$1', [id])
    await client.query('COMMIT')
    return normalizeItem(itemResult.rows[0])
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function saveInventoryBatch(input, key) {
  const batch = cleanInventoryBatch(input, key)
  const replay = existing => {
    if (existing.fingerprint !== batch.fingerprint) throw Object.assign(new Error('Esta referencia ya se usó para otro lote.'), { status: 409, code: 'BATCH_CONFLICT' })
    return { ...existing.result, replayed: true }
  }
  if (!pool) return mutateFileData(data => {
    const existing = data.stockBatches.find(b => b.key === batch.key)
    if (existing) return replay(existing)
    const changes = inventoryBatchChanges(data.items, batch), now = new Date().toISOString()
    for (const { item, next, delta } of changes) {
      item.quantity = next; item.updatedAt = now
      data.movements.unshift({ id: crypto.randomUUID(), itemId: item.id, itemName: item.name, saleId: null,
        type: batch.type, quantity: delta, balanceAfter: next, note: batch.note || (batch.type === 'stock_in' ? 'Producción por lote' : 'Conteo por lote'), createdAt: now })
    }
    const result = { id: batch.key, items: changes.map(c => normalizeItem(c.item)), count: changes.length }
    data.stockBatches.push({ key: batch.key, fingerprint: batch.fingerprint, result })
    return result
  })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`stock-batch:${batch.key}`])
    const previous = await client.query('SELECT fingerprint,result FROM stock_batches WHERE id=$1', [batch.key])
    if (previous.rows[0]) { const result = replay(previous.rows[0]); await client.query('COMMIT'); return result }
    const current = await client.query('SELECT * FROM items WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [batch.items.map(l => l.itemId)])
    if (batch.type === 'adjustment') await assertNoStockHolds(client, batch.items.map(l => l.itemId))
    const changes = inventoryBatchChanges(current.rows.map(normalizeItem), batch)
    const updated = await client.query(`UPDATE items i SET quantity=b.quantity, updated_at=NOW()
      FROM UNNEST($1::uuid[],$2::numeric[]) AS b(id,quantity) WHERE i.id=b.id RETURNING i.*`, [changes.map(c => c.item.id), changes.map(c => c.next)])
    await client.query(`INSERT INTO movements (id,item_id,item_name,type,quantity,balance_after,note)
      SELECT * FROM UNNEST($1::uuid[],$2::uuid[],$3::text[],$4::text[],$5::numeric[],$6::numeric[],$7::text[])`,
    [changes.map(() => crypto.randomUUID()), changes.map(c => c.item.id), changes.map(c => c.item.name), changes.map(() => batch.type),
      changes.map(c => c.delta), changes.map(c => c.next), changes.map(() => batch.note || (batch.type === 'stock_in' ? 'Producción por lote' : 'Conteo por lote'))])
    const result = { id: batch.key, items: updated.rows.map(normalizeItem), count: changes.length }
    await client.query('INSERT INTO stock_batches (id,fingerprint,result) VALUES ($1,$2,$3)', [batch.key, batch.fingerprint, JSON.stringify(result)])
    await client.query('COMMIT')
    return result
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}

export async function adjustItem(id, input) {
  if (!pool) {
    return mutateFileData((data) => {
      const item = data.items.find((entry) => entry.id === id)
      if (!item) return null
      const amount = Number(input.quantity)
      const next = input.type === 'stock_in' ? item.quantity + amount
        : input.type === 'stock_out' ? item.quantity - amount : amount
      if (next < 0) throw Object.assign(new Error('Stock cannot go below zero.'), { status: 400 })
      const delta = input.type === 'adjustment' ? next - item.quantity : (input.type === 'stock_out' ? -amount : amount)
      item.quantity = next
      item.updatedAt = new Date().toISOString()
      data.movements.unshift({
        id: crypto.randomUUID(), itemId: item.id, itemName: item.name, saleId: null, type: input.type,
        quantity: delta, balanceAfter: next, note: input.note || '', createdAt: item.updatedAt,
      })
      return normalizeItem(item)
    })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const currentResult = await client.query('SELECT * FROM items WHERE id=$1 FOR UPDATE', [id])
    if (!currentResult.rows[0]) {
      await client.query('ROLLBACK')
      return null
    }
    const current = Number(currentResult.rows[0].quantity)
    if (input.type === 'adjustment') await assertNoStockHolds(client, [id])
    const amount = Number(input.quantity)
    const next = input.type === 'stock_in' ? current + amount
      : input.type === 'stock_out' ? current - amount : amount
    if (next < 0) throw Object.assign(new Error('Stock cannot go below zero.'), { status: 400 })
    const delta = input.type === 'adjustment' ? next - current : (input.type === 'stock_out' ? -amount : amount)
    const { rows } = await client.query('UPDATE items SET quantity=$2, updated_at=NOW() WHERE id=$1 RETURNING *', [id, next])
    await client.query(
      `INSERT INTO movements (id, item_id, item_name, type, quantity, balance_after, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [crypto.randomUUID(), id, rows[0].name, input.type, delta, next, input.note || ''],
    )
    await client.query('COMMIT')
    return normalizeItem(rows[0])
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

function validateSaleLines(items, requested, allowShortfall = false) {
  const itemMap = new Map(items.map((item) => [item.id, item]))
  const combined = new Map()
  for (const line of requested) {
    if (!Number.isFinite(line.quantity) || line.quantity <= 0 || line.quantity > 10000 || Math.abs(line.quantity * 100 - Math.round(line.quantity * 100)) > .00001) throw userError('Indica una cantidad válida, con hasta dos decimales.')
    combined.set(line.itemId, (combined.get(line.itemId) || 0) + Math.round(line.quantity * 100))
  }
  return [...combined].map(([itemId, cents]) => {
    const line = { itemId, quantity: cents / 100 }
    if (cents > 1000000) throw userError('La cantidad máxima por producto es 10.000.')
    const item = itemMap.get(line.itemId)
    if (!item) throw Object.assign(new Error('One of the selected products no longer exists.'), { status: 400 })
    if (!item.sellable || Number(item.price) <= 0) throw Object.assign(new Error(`${item.name} is not configured for sale.`), { status: 400 })
    if (!allowShortfall && Number(item.quantity) < line.quantity) throw Object.assign(new Error(`There is not enough stock for ${item.name}.`), { status: 409 })
    const lineTotal = Math.round(Number(item.price) * line.quantity)
    const inventoryQuantity = Math.min(Number(item.quantity), line.quantity)
    return { item, quantity: line.quantity, inventoryQuantity, unitPrice: Number(item.price), lineTotal }
  })
}

function checkoutFingerprint(requested, paymentMethod, cashReceived = null) {
  const combined = new Map()
  for (const line of requested) combined.set(line.itemId, (combined.get(line.itemId) || 0) + Number(line.quantity))
  const values = [paymentMethod, [...combined].sort(([a], [b]) => a.localeCompare(b))]
  if (cashReceived != null) values.push(cashReceived)
  return crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex')
}

function assertSameCheckout(sale, fingerprint) {
  if ((sale.checkout_fingerprint ?? sale.checkoutFingerprint) !== fingerprint) {
    throw Object.assign(new Error('This checkout key was already used for a different cart or payment method.'), { status: 409, code: 'CHECKOUT_CONFLICT' })
  }
}

function reserveSaleInFile(data, requested, paymentMethod, checkoutKey, cashReceived, actor) {
  const fingerprint = checkoutFingerprint(requested, paymentMethod, cashReceived)
  const existing = checkoutKey && data.sales.find(sale => sale.checkoutKey === checkoutKey)
  if (existing) {
    if(actor&&existing.cashierId!==actor.id&&!(actor.role==='admin'&&!existing.cashierId))throw userError('Venta no encontrada.',404)
    assertSameCheckout(existing, fingerprint)
    return { ...normalizeSale(existing), checkoutReplayed: true }
  }
  if(actor&&!data.registerSessions.some(s=>s.id===actor.sessionId&&s.userId===actor.id&&!s.closedAt))throw userError('Abre una sesión de caja para vender.',409,'SESSION_REQUIRED')
  const lines = validateSaleLines(data.items.map(normalizeItem), requested, Boolean(actor))
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  const total = lines.reduce((sum, line) => sum + line.lineTotal, 0)
  validateCashReceived(cashReceived, paymentMethod, total)
  const sale = {
    id,
    checkoutKey,
    checkoutFingerprint: fingerprint,
    status: paymentMethod === 'cash' ? 'paid' : 'pending',
    paymentMethod,
    total,
    cashReceived,
    cashierId:actor?.id||null,cashierName:actor?.name||'',registerSessionId:actor?.sessionId||null,
    items: lines.map(({ item, quantity, inventoryQuantity, unitPrice, lineTotal }) => ({ lineId: crypto.randomUUID(), itemId: item.id, name: item.name, unit: item.unit, quantity, inventoryQuantity, unitPrice, lineTotal })),
    refunds: [],
    mpOrderId: null,
    mpPaymentId: null,
    mpExternalReference: saleExternalReference(id),
    mpOperationId: null,
    mpAuthorizationCode: '',
    mpCardBrand: '',
    mpCardLastFour: '',
    mpPaymentType: '',
    mpFeeAmount: 0,
    mpNetReceivedAmount: null,
    mpTerminalSerial: '',
    mpTaxSetting: '',
    mpReconciledAt: null,
    pilotReceiptStatus: 'not_requested',
    pilotReceiptActionId: null,
    pilotReceiptError: '',
    pilotReceiptPrintedAt: null,
    mpStatus: null,
    mpStatusDetail: null,
    inventoryApplied: true,
    createdAt: now,
    updatedAt: now,
    paidAt: paymentMethod === 'cash' ? now : null,
  }
  for (const line of lines) {
    const item = data.items.find((entry) => entry.id === line.item.id)
    item.quantity = Math.round((Number(item.quantity) - line.inventoryQuantity) * 100) / 100
    item.updatedAt = now
    data.movements.unshift({
      id: crypto.randomUUID(), itemId: item.id, itemName: item.name, saleId: id, type: 'stock_out',
      quantity: -line.inventoryQuantity, balanceAfter: item.quantity,
      note: `${paymentMethod === 'cash' ? `Sale #${shortId(id)}` : `Reserved for card sale #${shortId(id)}`}${line.quantity > line.inventoryQuantity ? ` · Sin stock registrado: ${Math.round((line.quantity-line.inventoryQuantity)*100)/100}` : ''}`,
      createdAt: now,
    })
  }
  data.sales.unshift(sale)
  return normalizeSale(sale)
}

function validateCashReceived(received, method, total) {
  if (received != null && (method !== 'cash' || !Number.isSafeInteger(received) || received < total || received > 999999999999)) {
    throw Object.assign(new Error('El efectivo recibido debe cubrir el total y ser un monto entero en CLP.'), { status: 400 })
  }
}

export async function createSale(requested, paymentMethod, checkoutKey = null, cashReceived = null, actor = null) {
  if (!pool) return mutateFileData((data) => reserveSaleInFile(data, requested, paymentMethod, checkoutKey, cashReceived, actor))

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const fingerprint = checkoutFingerprint(requested, paymentMethod, cashReceived)
    if (checkoutKey) {
      // Serialize the same checkout across processes before touching inventory.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`checkout:${checkoutKey}`])
      const existing = await client.query('SELECT * FROM sales WHERE checkout_key=$1', [checkoutKey])
      if (existing.rows.length) {
        if(actor&&existing.rows[0].cashier_id!==actor.id&&!(actor.role==='admin'&&!existing.rows[0].cashier_id))throw userError('Venta no encontrada.',404)
        assertSameCheckout(existing.rows[0], fingerprint)
        const [sale] = await hydratePostgresSales(existing.rows, client)
        await client.query('COMMIT')
        return { ...sale, checkoutReplayed: true }
      }
    }
    if(actor){const session=(await client.query('SELECT id FROM register_sessions WHERE id=$1 AND user_id=$2 AND closed_at IS NULL FOR UPDATE',[actor.sessionId,actor.id])).rows[0];if(!session)throw userError('Abre una sesión de caja para vender.',409,'SESSION_REQUIRED')}
    const ids = [...new Set(requested.map((line) => line.itemId))].sort()
    const itemResult = await client.query('SELECT * FROM items WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids])
    const lines = validateSaleLines(itemResult.rows.map(normalizeItem), requested, Boolean(actor))
    const id = crypto.randomUUID()
    const total = lines.reduce((sum, line) => sum + line.lineTotal, 0)
    validateCashReceived(cashReceived, paymentMethod, total)
    const status = paymentMethod === 'cash' ? 'paid' : 'pending'
    const saleResult = await client.query(
      `INSERT INTO sales (id, status, payment_method, total, mp_external_reference, inventory_applied, paid_at, checkout_key, checkout_fingerprint, cash_received,cashier_id,cashier_name,register_session_id)
       VALUES ($1,$2,$3,$4,$5,TRUE,CASE WHEN $2='paid' THEN NOW() ELSE NULL END,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [id, status, paymentMethod, total, saleExternalReference(id), checkoutKey, fingerprint, cashReceived,actor?.id||null,actor?.name||'',actor?.sessionId||null],
    )
    const persistedLines = lines.map((line) => ({ ...line, lineId: crypto.randomUUID() }))
    await client.query(
      `INSERT INTO sale_items (id, sale_id, item_id, item_name, unit, quantity, unit_price, line_total, inventory_quantity)
       SELECT * FROM UNNEST(
         $1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::numeric[], $7::numeric[], $8::numeric[], $9::numeric[]
       )`,
      [
        persistedLines.map((line) => line.lineId),
        persistedLines.map(() => id),
        persistedLines.map((line) => line.item.id),
        persistedLines.map((line) => line.item.name),
        persistedLines.map((line) => line.item.unit),
        persistedLines.map((line) => line.quantity),
        persistedLines.map((line) => line.unitPrice),
        persistedLines.map((line) => line.lineTotal),
        persistedLines.map((line) => line.inventoryQuantity),
      ],
    )
    const updatedItems = await client.query(
      `WITH requested(item_id, quantity) AS (
         SELECT * FROM UNNEST($1::uuid[], $2::numeric[])
       )
       UPDATE items AS item
       SET quantity=item.quantity-requested.quantity, updated_at=NOW()
       FROM requested
       WHERE item.id=requested.item_id
       RETURNING item.id, item.quantity`,
      [persistedLines.map((line) => line.item.id), persistedLines.map((line) => line.inventoryQuantity)],
    )
    const balances = new Map(updatedItems.rows.map((item) => [item.id, item.quantity]))
    const movementNote = paymentMethod === 'cash' ? `Sale #${shortId(id)}` : `Reserved for card sale #${shortId(id)}`
    await client.query(
      `INSERT INTO movements (id, item_id, item_name, type, quantity, balance_after, note, sale_id)
       SELECT movement_id, item_id, item_name, 'stock_out', quantity, balance_after, note, sale_id
       FROM UNNEST(
         $1::uuid[], $2::uuid[], $3::text[], $4::numeric[], $5::numeric[], $6::text[], $7::uuid[]
       ) AS batch(movement_id, item_id, item_name, quantity, balance_after, note, sale_id)`,
      [
        persistedLines.map(() => crypto.randomUUID()),
        persistedLines.map((line) => line.item.id),
        persistedLines.map((line) => line.item.name),
        persistedLines.map((line) => -line.inventoryQuantity),
        persistedLines.map((line) => balances.get(line.item.id)),
        persistedLines.map(line => movementNote + (line.quantity > line.inventoryQuantity ? ` · Sin stock registrado: ${Math.round((line.quantity-line.inventoryQuantity)*100)/100}` : '')),
        persistedLines.map(() => id),
      ],
    )
    await client.query('COMMIT')
    return normalizeSale(saleResult.rows[0], persistedLines.map((line) => ({
      id: line.lineId, item_id: line.item.id, item_name: line.item.name, unit: line.item.unit,
      quantity: line.quantity, inventory_quantity: line.inventoryQuantity, unit_price: line.unitPrice, line_total: line.lineTotal,
    })))
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function attachPointOrder(saleId, order, knownSale = null) {
  const payment = order?.transactions?.payments?.[0]
  if (!pool) {
    return mutateFileData((data) => {
      const sale = data.sales.find((entry) => entry.id === saleId)
      if (!sale) return null
      sale.mpOrderId = order.id
      sale.mpPaymentId = payment?.id || null
      sale.mpExternalReference = order.external_reference || sale.mpExternalReference || saleExternalReference(sale.id)
      sale.mpStatus = order.status || null
      sale.mpStatusDetail = order.status_detail || null
      sale.updatedAt = new Date().toISOString()
      return normalizeSale(sale)
    })
  }
  const { rows } = await pool.query(
    `UPDATE sales SET mp_order_id=$2, mp_payment_id=$3, mp_status=$4, mp_status_detail=$5,
     mp_external_reference=COALESCE($6,mp_external_reference), updated_at=NOW()
     WHERE id=$1 RETURNING *`,
    [saleId, order.id, payment?.id || null, order.status || null, order.status_detail || null, order.external_reference || null],
  )
  if (rows[0] && knownSale) return normalizeSale(rows[0], knownSale.items, knownSale.refunds)
  return rows[0] ? getSale(rows[0].id) : null
}

function localStatusForPoint(order) {
  if (order.status === 'processed' && ['accredited', 'partially_refunded'].includes(order.status_detail)) return 'paid'
  if (order.status === 'processed' && ['accredited', 'partially_refunded'].includes(order.transactions?.payments?.[0]?.status_detail)) return 'paid'
  if (order.status === 'canceled') return 'cancelled'
  if (order.status === 'failed') return 'failed'
  if (order.status === 'expired') return 'expired'
  if (order.status === 'refunded') return 'refunded'
  return 'pending'
}

function restoreFileSale(data, sale, status, detail) {
  if (sale.inventoryApplied && ['failed', 'cancelled', 'expired'].includes(status)) {
    const now = new Date().toISOString()
    for (const line of sale.items) {
      const item = data.items.find((entry) => entry.id === line.itemId)
      if (!item) continue
      const restored = Number(line.inventoryQuantity ?? line.quantity)
      item.quantity = Number(item.quantity) + restored
      item.updatedAt = now
      data.movements.unshift({
        id: crypto.randomUUID(), itemId: item.id, itemName: item.name, saleId: sale.id, type: 'stock_in',
        quantity: restored, balanceAfter: item.quantity,
        note: `Card sale #${shortId(sale.id)} ${status} — stock restored`, createdAt: now,
      })
    }
    sale.inventoryApplied = false
  }
  sale.status = status
  sale.mpStatus = status
  sale.mpStatusDetail = detail || status
  sale.updatedAt = new Date().toISOString()
  return normalizeSale(sale)
}

export async function markCardSaleFailed(saleId, detail = 'order_creation_failed') {
  if (!pool) return mutateFileData((data) => {
    const sale = data.sales.find((entry) => entry.id === saleId)
    return sale ? restoreFileSale(data, sale, 'failed', detail) : null
  })
  return updatePostgresSaleStatus(saleId, 'failed', 'failed', detail)
}

function processedPointRefunds(order) {
  return (order?.transactions?.refunds || []).filter((refund) => refund?.id && refund.status === 'processed')
}

function remainingRefundLines(sale) {
  const refundedByLine = new Map()
  for (const refund of sale.refunds.filter((entry) => entry.status === 'processed')) {
    for (const line of refund.items) refundedByLine.set(line.lineId, (refundedByLine.get(line.lineId) || 0) + line.quantity)
  }
  return sale.items.map((line) => {
    const quantity = Math.max(0, Number(line.quantity) - Number(refundedByLine.get(line.lineId) || 0))
    return { ...line, quantity, lineTotal: Math.round(Number(line.unitPrice) * quantity), restocked: false }
  }).filter((line) => line.quantity > 0)
}

function ingestFilePointRefunds(sale, order) {
  const now = new Date().toISOString()
  for (const pointRefund of processedPointRefunds(order)) {
    if (sale.refunds.some((refund) => refund.mpRefundId === pointRefund.id)) continue
    const amount = Math.round(Number(pointRefund.amount || 0))
    if (amount <= 0) continue
    if (sale.refunds.some((refund) => refund.status === 'pending' && !refund.mpRefundId && Number(refund.amount) === amount)) continue
    const refundedTotal = sale.refunds.filter((refund) => refund.status === 'processed').reduce((sum, refund) => sum + Number(refund.amount), 0)
    const full = amount >= Math.max(Number(sale.total) - refundedTotal, 0)
    const candidateItems = full ? remainingRefundLines(normalizeSale(sale)) : []
    const itemsMatchAmount = candidateItems.reduce((sum, line) => sum + line.lineTotal, 0) === amount
    sale.refunds.unshift({
      id: crypto.randomUUID(), saleId: sale.id, status: 'processed', amount,
      reason: 'Mercado Pago / Point', restock: false, creditNoteRequired: false,
      originalDocumentType: '', originalFolio: '', mpRefundId: pointRefund.id,
      mpReferenceId: pointRefund.reference_id || null, mpStatus: pointRefund.status,
      source: 'point_terminal', inventoryReviewStatus: 'pending', errorDetail: '',
      items: itemsMatchAmount ? candidateItems : [], creditNote: null,
      createdAt: pointRefund.date_created || now, updatedAt: now, processedAt: pointRefund.date_created || now,
    })
  }
}

async function ingestPostgresPointRefunds(client, sale, order) {
  const pointRefunds = processedPointRefunds(order)
  if (!pointRefunds.length) return
  const existingResult = await client.query('SELECT * FROM refunds WHERE sale_id=$1 ORDER BY created_at FOR UPDATE', [sale.id])
  for (const pointRefund of pointRefunds) {
    if (existingResult.rows.some((refund) => refund.mp_refund_id === pointRefund.id)) continue
    const amount = Math.round(Number(pointRefund.amount || 0))
    if (amount <= 0) continue
    if (existingResult.rows.some((refund) => refund.status === 'pending' && !refund.mp_refund_id && Number(refund.amount) === amount)) continue

    const refundedTotal = existingResult.rows
      .filter((refund) => refund.status === 'processed')
      .reduce((sum, refund) => sum + Number(refund.amount), 0)
    const full = amount >= Math.max(Number(sale.total) - refundedTotal, 0)
    const refundId = crypto.randomUUID()
    await client.query(
      `INSERT INTO refunds (
        id, sale_id, status, amount, reason, restock, credit_note_required,
        mp_refund_id, mp_reference_id, mp_status, source, inventory_review_status,
        created_at, updated_at, processed_at
      ) VALUES ($1,$2,'processed',$3,'Mercado Pago / Point',FALSE,FALSE,$4,$5,$6,'point_terminal','pending',
        COALESCE($7::timestamptz,NOW()),NOW(),COALESCE($7::timestamptz,NOW()))`,
      [refundId, sale.id, amount, pointRefund.id, pointRefund.reference_id || null, pointRefund.status, pointRefund.date_created || null],
    )
    const inserted = { id: refundId, status: 'processed', amount, mp_refund_id: pointRefund.id }
    existingResult.rows.push(inserted)
    if (!full) continue

    const lineResult = await client.query(
      `SELECT si.*, GREATEST(si.quantity-COALESCE(SUM(CASE WHEN r.status='processed' THEN ri.quantity ELSE 0 END),0),0) AS remaining_quantity
       FROM sale_items si
       LEFT JOIN refund_items ri ON ri.sale_item_id=si.id
       LEFT JOIN refunds r ON r.id=ri.refund_id
       WHERE si.sale_id=$1
       GROUP BY si.id
       ORDER BY si.item_name`,
      [sale.id],
    )
    const remainingLines = lineResult.rows.filter((entry) => Number(entry.remaining_quantity) > 0)
    const remainingLinesTotal = remainingLines.reduce(
      (sum, line) => sum + Math.round(Number(line.unit_price) * Number(line.remaining_quantity)),
      0,
    )
    if (remainingLinesTotal !== amount) continue
    for (const line of remainingLines) {
      await client.query(
        `INSERT INTO refund_items (
          id, refund_id, sale_item_id, item_id, item_name, quantity, unit_price, line_total, restocked
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,FALSE)`,
        [crypto.randomUUID(), refundId, line.id, line.item_id, line.item_name, line.remaining_quantity,
          line.unit_price, Math.round(Number(line.unit_price) * Number(line.remaining_quantity))],
      )
    }
  }
}

export async function updateSaleFromPoint(order) {
  const status = localStatusForPoint(order)
  const payment = order?.transactions?.payments?.[0]
  if (!pool) return mutateFileData((data) => {
    const sale = data.sales.find((entry) => entry.mpOrderId === order.id
      || entry.mpExternalReference === order.external_reference
      || `sale-${entry.id}` === order.external_reference)
    if (!sale) return null
    sale.mpOrderId = order.id || sale.mpOrderId
    sale.mpPaymentId = payment?.id || sale.mpPaymentId
    sale.mpExternalReference = order.external_reference || sale.mpExternalReference || saleExternalReference(sale.id)
    sale.mpOperationId = payment?.reference_id || sale.mpOperationId || null
    restoreFileSale(data, sale, status, order.status_detail)
    ingestFilePointRefunds(sale, order)
    sale.mpStatus = order.status
    sale.mpStatusDetail = order.status_detail
    if (status === 'paid' && !sale.paidAt) sale.paidAt = new Date().toISOString()
    return normalizeSale(sale)
  })

  const lookup = order.id
    ? await pool.query(
      `SELECT id FROM sales
       WHERE mp_order_id=$1 OR mp_external_reference=$2 OR $2=CONCAT('sale-',id::text)
       LIMIT 1`,
      [order.id, order.external_reference || ''],
    )
    : { rows: [] }
  if (!lookup.rows[0]) return null
  const sale = await updatePostgresSaleStatus(lookup.rows[0].id, status, order.status, order.status_detail, payment?.id, order.id, order)
  return sale
}

// Lock the complete product set in UUID order before any item UPDATE can lock
// inventory_read_revision. Lock products before child lines too (DELETE SET NULL).
// The caller holds the parent sale, serializing its refund/reconciliation paths.
async function lockPostgresSaleProducts(client, saleId) {
  await client.query(`SELECT id FROM items WHERE id IN
    (SELECT item_id FROM sale_items WHERE sale_id=$1) ORDER BY id FOR UPDATE`, [saleId])
}

async function lockPostgresRefundProducts(client, refundId) {
  await client.query(`SELECT id FROM items WHERE id IN
    (SELECT item_id FROM refund_items WHERE refund_id=$1) ORDER BY id FOR UPDATE`, [refundId])
}

async function updatePostgresSaleStatus(saleId, status, mpStatus, mpStatusDetail, mpPaymentId = null, mpOrderId = null, order = null) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const saleResult = await client.query('SELECT * FROM sales WHERE id=$1 FOR UPDATE', [saleId])
    const sale = saleResult.rows[0]
    if (!sale) { await client.query('ROLLBACK'); return null }
    const restoreInventory = sale.inventory_applied && ['failed', 'cancelled', 'expired'].includes(status)
    if (restoreInventory || processedPointRefunds(order).length) await lockPostgresSaleProducts(client, saleId)
    if (restoreInventory) {
      const itemResult = await client.query('SELECT * FROM sale_items WHERE sale_id=$1 ORDER BY item_id', [saleId])
      for (const line of itemResult.rows) {
        const restored = line.inventory_quantity ?? line.quantity
        const updated = await client.query('UPDATE items SET quantity=quantity+$2, updated_at=NOW() WHERE id=$1 RETURNING quantity', [line.item_id, restored])
        await client.query(
          `INSERT INTO movements (id, item_id, item_name, type, quantity, balance_after, note, sale_id)
           VALUES ($1,$2,$3,'stock_in',$4,$5,$6,$7)`,
          [crypto.randomUUID(), line.item_id, line.item_name, restored, updated.rows[0].quantity,
            `Card sale #${shortId(saleId)} ${status} — stock restored`, saleId],
        )
      }
    }
    await ingestPostgresPointRefunds(client, sale, { ...order, transactions: order?.transactions })
    const refundTotalResult = await client.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM refunds WHERE sale_id=$1 AND status='processed'`,
      [saleId],
    )
    const reconciledStatus = Number(refundTotalResult.rows[0].total) >= Number(sale.total) ? 'refunded' : status
    await client.query(
      `UPDATE sales SET status=$2, mp_status=$3, mp_status_detail=$4,
       mp_payment_id=COALESCE($5, mp_payment_id),
       mp_order_id=COALESCE($6, mp_order_id),
       mp_external_reference=COALESCE($7,mp_external_reference),
       mp_operation_id=COALESCE($8,mp_operation_id),
       inventory_applied=CASE WHEN $2 IN ('failed','cancelled','expired') THEN FALSE ELSE inventory_applied END,
       paid_at=CASE WHEN $2='paid' THEN COALESCE(paid_at,NOW()) ELSE paid_at END, updated_at=NOW()
       WHERE id=$1`,
      [saleId, reconciledStatus, mpStatus || status, mpStatusDetail || status, mpPaymentId, mpOrderId,
        order?.external_reference || null, order?.transactions?.payments?.[0]?.reference_id || null],
    )
    await client.query('COMMIT')
    return getSale(saleId)
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

function pointPaymentDetails(payment) {
  const fees = Array.isArray(payment?.fee_details)
    ? payment.fee_details.reduce((sum, fee) => sum + Number(fee.amount || 0), 0)
    : 0
  return {
    operationId: payment?.id == null ? null : String(payment.id),
    authorizationCode: String(payment?.authorization_code || ''),
    cardBrand: String(payment?.payment_method_id || payment?.payment_method?.id || ''),
    cardLastFour: String(payment?.card?.last_four_digits || ''),
    paymentType: String(payment?.payment_type_id || payment?.payment_method?.type || ''),
    feeAmount: Math.round(fees),
    netReceivedAmount: payment?.transaction_details?.net_received_amount == null
      ? null : Math.round(Number(payment.transaction_details.net_received_amount)),
    terminalSerial: String(
      payment?.point_of_interaction?.transaction_data?.terminal_id
      || payment?.point_of_interaction?.transaction_data?.device_id
      || payment?.additional_info?.terminal_id
      || '',
    ),
    taxSetting: String(payment?.additional_info?.tax_setting || ''),
  }
}

export async function updateSalePaymentDetails(saleId, payment) {
  const details = pointPaymentDetails(payment)
  if (!pool) return mutateFileData((data) => {
    const sale = data.sales.find((entry) => entry.id === saleId)
    if (!sale) return null
    Object.assign(sale, {
      mpOperationId: details.operationId || sale.mpOperationId || null,
      mpAuthorizationCode: details.authorizationCode,
      mpCardBrand: details.cardBrand,
      mpCardLastFour: details.cardLastFour,
      mpPaymentType: details.paymentType,
      mpFeeAmount: details.feeAmount,
      mpNetReceivedAmount: details.netReceivedAmount,
      mpTerminalSerial: details.terminalSerial,
      mpTaxSetting: details.taxSetting,
      mpReconciledAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    return normalizeSale(sale)
  })

  const { rows } = await pool.query(
    `UPDATE sales SET
      mp_operation_id=COALESCE($2,mp_operation_id), mp_authorization_code=$3,
      mp_card_brand=$4, mp_card_last_four=$5, mp_payment_type=$6,
      mp_fee_amount=$7, mp_net_received_amount=$8, mp_terminal_serial=$9,
      mp_tax_setting=$10, mp_reconciled_at=NOW(), updated_at=NOW()
     WHERE id=$1 RETURNING id`,
    [saleId, details.operationId, details.authorizationCode, details.cardBrand, details.cardLastFour,
      details.paymentType, details.feeAmount, details.netReceivedAmount, details.terminalSerial, details.taxSetting],
  )
  return rows[0] ? getSale(saleId) : null
}

export async function claimPilotReceiptPrint(saleId, retryFailed = false, forceReprint = false) {
  if (!pool) return mutateFileData((data) => {
    const sale = data.sales.find((entry) => entry.id === saleId)
    if (!sale || !['paid', 'refunded'].includes(sale.status)) return null
    const stale = sale.pilotReceiptStatus === 'printing'
      && Date.now() - new Date(sale.updatedAt || 0).getTime() > 120000
    const claimable = sale.pilotReceiptStatus === 'not_requested'
      || stale
      || (retryFailed && sale.pilotReceiptStatus === 'failed')
      || (forceReprint && ['sent', 'printed'].includes(sale.pilotReceiptStatus))
    if (!claimable) return null
    sale.pilotReceiptStatus = 'printing'
    sale.pilotReceiptError = ''
    sale.updatedAt = new Date().toISOString()
    return normalizeSale(sale)
  })

  const { rows } = await pool.query(
    `UPDATE sales SET pilot_receipt_status='printing', pilot_receipt_error='', updated_at=NOW()
     WHERE id=$1 AND status IN ('paid','refunded')
       AND (pilot_receipt_status='not_requested'
          OR (pilot_receipt_status='printing' AND updated_at < NOW() - INTERVAL '2 minutes')
         OR ($2::boolean AND pilot_receipt_status='failed')
         OR ($3::boolean AND pilot_receipt_status IN ('sent','printed')))
     RETURNING id`,
    [saleId, retryFailed, forceReprint],
  )
  return rows[0] ? getSale(saleId) : null
}

export async function completePilotReceiptPrint(saleId, action) {
  const actionId = action?.id ? String(action.id) : null
  const processed = action?.status === 'processed'
  const receiptStatus = processed ? 'printed' : 'sent'
  if (!pool) return mutateFileData((data) => {
    const sale = data.sales.find((entry) => entry.id === saleId)
    if (!sale) return null
    sale.pilotReceiptStatus = receiptStatus
    sale.pilotReceiptActionId = actionId
    sale.pilotReceiptError = ''
    const now = new Date().toISOString()
    if (processed) sale.pilotReceiptPrintedAt = now
    sale.updatedAt = now
    return normalizeSale(sale)
  })
  const { rows } = await pool.query(
    `UPDATE sales SET pilot_receipt_status=$3, pilot_receipt_action_id=$2,
     pilot_receipt_error='', pilot_receipt_printed_at=CASE WHEN $4::boolean THEN NOW() ELSE pilot_receipt_printed_at END,
     updated_at=NOW()
     WHERE id=$1 RETURNING id`,
    [saleId, actionId, receiptStatus, processed],
  )
  return rows[0] ? getSale(saleId) : null
}

export async function failPilotReceiptPrint(saleId, error) {
  const detail = String(error || 'Point print failed').slice(0, 500)
  if (!pool) return mutateFileData((data) => {
    const sale = data.sales.find((entry) => entry.id === saleId)
    if (!sale) return null
    sale.pilotReceiptStatus = 'failed'
    sale.pilotReceiptError = detail
    sale.updatedAt = new Date().toISOString()
    return normalizeSale(sale)
  })
  const { rows } = await pool.query(
    `UPDATE sales SET pilot_receipt_status='failed', pilot_receipt_error=$2, updated_at=NOW()
     WHERE id=$1 RETURNING id`,
    [saleId, detail],
  )
  return rows[0] ? getSale(saleId) : null
}

function refundConflict(message) {
  return Object.assign(new Error(message), { status: 409 })
}

function refundLinesForSale(sale, requested = [], requestedAmount) {
  if (sale.status !== 'paid') throw refundConflict('Only an approved sale can be refunded.')
  if (sale.refunds.some((refund) => refund.status === 'pending')) throw refundConflict('This sale already has a refund in progress.')
  if (sale.refundableTotal <= 0) throw refundConflict('This sale has already been refunded in full.')

  const refundedByLine = new Map()
  for (const refund of sale.refunds.filter((entry) => entry.status === 'processed')) {
    for (const line of refund.items) refundedByLine.set(line.lineId, (refundedByLine.get(line.lineId) || 0) + line.quantity)
  }
  const saleLines = new Map(sale.items.map((line) => [line.lineId, line]))
  const combined = new Map()
  for (const line of requested) combined.set(line.lineId, (combined.get(line.lineId) || 0) + Number(line.quantity))
  const lines = [...combined.entries()].map(([lineId, quantity]) => {
    const saleLine = saleLines.get(lineId)
    if (!saleLine) throw Object.assign(new Error('One of the selected sale lines no longer exists.'), { status: 400 })
    const remaining = Number(saleLine.quantity) - Number(refundedByLine.get(lineId) || 0)
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > remaining) {
      throw Object.assign(new Error(`The refundable quantity for ${saleLine.name} is ${remaining}.`), { status: 400 })
    }
    return {
      lineId,
      itemId: saleLine.itemId || null,
      name: saleLine.name,
      quantity,
      unitPrice: saleLine.unitPrice,
      lineTotal: Math.round(saleLine.unitPrice * quantity),
      restocked: false,
    }
  })
  const amount = Math.round(Number(requestedAmount))
  if (!Number.isInteger(Number(requestedAmount)) || amount < 1 || amount > sale.refundableTotal) {
    throw Object.assign(new Error(`Enter a refund amount between CLP 1 and CLP ${sale.refundableTotal}.`), { status: 400 })
  }
  return { lines, amount, full: sale.refundedTotal + amount >= sale.total }
}

function refundInputRecord(saleId, input, calculated) {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    saleId,
    status: 'pending',
    amount: calculated.amount,
    reason: input.reason,
    restock: input.restock,
    creditNoteRequired: input.creditNoteRequired,
    originalDocumentType: input.originalDocumentType,
    originalFolio: input.originalFolio,
    mpRefundId: null,
    mpStatus: null,
    errorDetail: '',
    items: calculated.lines,
    creditNote: null,
    createdAt: now,
    updatedAt: now,
    processedAt: null,
  }
}

export async function prepareRefund(saleId, input) {
  if (!pool) {
    return mutateFileData((data) => {
      const storedSale = data.sales.find((entry) => entry.id === saleId)
      if (!storedSale) return null
      const sale = normalizeSale(storedSale)
      const calculated = refundLinesForSale(sale, input.items, input.amount)
      const refund = refundInputRecord(saleId, input, calculated)
      storedSale.refunds.unshift(refund)
      storedSale.updatedAt = refund.updatedAt
      return { sale: normalizeSale(storedSale), refund: normalizeRefund(refund), full: calculated.full }
    })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const saleResult = await client.query('SELECT * FROM sales WHERE id=$1 FOR UPDATE', [saleId])
    if (!saleResult.rows[0]) { await client.query('ROLLBACK'); return null }
    const refundResult = await client.query('SELECT * FROM refunds WHERE sale_id=$1 ORDER BY created_at DESC FOR UPDATE', [saleId])
    // Refund line inserts also take product FK locks; acquire the full set first.
    await lockPostgresSaleProducts(client, saleId)
    const itemResult = await client.query('SELECT * FROM sale_items WHERE sale_id=$1 ORDER BY item_name', [saleId])
    const refundItemResult = await client.query(`SELECT ri.* FROM refund_items ri JOIN refunds r ON r.id=ri.refund_id WHERE r.sale_id=$1`, [saleId])
    const creditNoteResult = await client.query('SELECT * FROM tax_documents WHERE sale_id=$1', [saleId])
    const itemsByRefund = new Map()
    for (const item of refundItemResult.rows) {
      const entries = itemsByRefund.get(item.refund_id) || []
      entries.push(item)
      itemsByRefund.set(item.refund_id, entries)
    }
    const creditNoteByRefund = new Map(creditNoteResult.rows.map((document) => [document.refund_id, document]))
    const refunds = refundResult.rows.map((refund) => ({
      ...refund,
      items: itemsByRefund.get(refund.id) || [],
      creditNote: creditNoteByRefund.get(refund.id) || null,
    }))
    const sale = normalizeSale(saleResult.rows[0], itemResult.rows, refunds)
    const calculated = refundLinesForSale(sale, input.items, input.amount)
    const refund = refundInputRecord(saleId, input, calculated)
    await client.query(
      `INSERT INTO refunds (
        id, sale_id, status, amount, reason, restock, credit_note_required,
        original_document_type, original_folio, created_at, updated_at
      ) VALUES ($1,$2,'pending',$3,$4,$5,$6,$7,$8,$9,$9)`,
      [refund.id, saleId, refund.amount, refund.reason, refund.restock, refund.creditNoteRequired,
        refund.originalDocumentType, refund.originalFolio, refund.createdAt],
    )
    for (const line of refund.items) {
      await client.query(
        `INSERT INTO refund_items (
          id, refund_id, sale_item_id, item_id, item_name, quantity, unit_price, line_total, restocked
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,FALSE)`,
        [crypto.randomUUID(), refund.id, line.lineId, line.itemId, line.name, line.quantity, line.unitPrice, line.lineTotal],
      )
    }
    await client.query('COMMIT')
    const hydrated = await getSale(saleId)
    return { sale: hydrated, refund: hydrated.refunds.find((entry) => entry.id === refund.id), full: calculated.full }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

function pointRefundIdentifier(order) {
  const refunds = order?.transactions?.refunds || []
  return refunds.at(-1)?.id || null
}

export async function completeRefund(refundId, order = null) {
  const mpRefundId = pointRefundIdentifier(order)
  const mpStatus = order?.transactions?.refunds?.at(-1)?.status || order?.status || 'processed'
  if (!pool) {
    return mutateFileData((data) => {
      const sale = data.sales.find((entry) => entry.refunds.some((refund) => refund.id === refundId))
      if (!sale) return null
      const refund = sale.refunds.find((entry) => entry.id === refundId)
      if (refund.status === 'processed') return normalizeSale(sale)
      if (refund.status !== 'pending') throw refundConflict('This refund can no longer be completed.')
      const register = data.registerSessions.find(s=>s.id===sale.registerSessionId&&!s.closedAt)
      if(sale.paymentMethod==='cash'&&register){
        const net=sessionSummary(data.sales.filter(s=>s.registerSessionId===register.id).map(s=>normalizeSale(s)),normalizeRegister(register)).cash.net
        const ledger=data.cashEntries.filter(e=>e.sessionId===register.id).reduce((sum,e)=>sum+(e.kind==='return'?e.amount:-e.amount),0)
        if(Number(register.openingCash)+net+ledger<refund.amount)throw userError('No hay efectivo disponible para esta devolución.',409,'INSUFFICIENT_CASH')
      }
      const now = new Date().toISOString()
      if (refund.restock) {
        for (const line of refund.items) {
          const item = data.items.find((entry) => entry.id === line.itemId)
          if (!item) continue
          item.quantity = Number(item.quantity) + Number(line.quantity)
          item.updatedAt = now
          line.restocked = true
          data.movements.unshift({
            id: crypto.randomUUID(), itemId: item.id, itemName: item.name, saleId: sale.id, type: 'stock_in',
            quantity: Number(line.quantity), balanceAfter: item.quantity,
            note: `Refund #${shortId(refund.id)} — stock restored`, createdAt: now,
          })
        }
      }
      Object.assign(refund, { status: 'processed', mpRefundId, mpStatus, errorDetail: '', updatedAt: now, processedAt: now })
      if (refund.creditNoteRequired) {
        refund.creditNote = {
          id: crypto.randomUUID(), status: 'pending', mode: 'manual',
          originalDocumentType: refund.originalDocumentType, originalFolio: refund.originalFolio,
          folio: '', siiTrackId: '', errorDetail: '', createdAt: now, updatedAt: now, issuedAt: null,
        }
      }
      const refundedTotal = sale.refunds.filter((entry) => entry.status === 'processed').reduce((sum, entry) => sum + Number(entry.amount), 0)
      sale.status = refundedTotal >= Number(sale.total) ? 'refunded' : 'paid'
      if (order) {
        sale.mpStatus = order.status || sale.mpStatus
        sale.mpStatusDetail = order.status_detail || sale.mpStatusDetail
      }
      sale.updatedAt = now
      return normalizeSale(sale)
    })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Discover the immutable parent without locking the child first. All paths
    // that lock both an existing sale and its refunds must acquire the sale first.
    const parent = (await client.query('SELECT r.sale_id,s.payment_method,s.register_session_id FROM refunds r JOIN sales s ON s.id=r.sale_id WHERE r.id=$1', [refundId])).rows[0]
    if (!parent) { await client.query('ROLLBACK'); return null }
    // Cash refunds and withdrawals share the register mutex, before sale/refund
    // locks. This keeps an expense and a refund from spending the same cash.
    const cashRegister = parent.payment_method==='cash'&&parent.register_session_id
      ? (await client.query('SELECT * FROM register_sessions WHERE id=$1 FOR UPDATE',[parent.register_session_id])).rows[0] : null
    const saleResult = await client.query('SELECT * FROM sales WHERE id=$1 FOR UPDATE', [parent.sale_id])
    const refundResult = await client.query('SELECT * FROM refunds WHERE id=$1 FOR UPDATE', [refundId])
    const refund = refundResult.rows[0]
    if (!refund) { await client.query('ROLLBACK'); return null }
    if (refund.status === 'processed') { await client.query('COMMIT'); return getSale(refund.sale_id) }
    if (refund.status !== 'pending') throw refundConflict('This refund can no longer be completed.')
    if(cashRegister&&!cashRegister.closed_at&&(await getRegisterCashStore().balance(cashRegister,client)).balance<Number(refund.amount))throw userError('No hay efectivo disponible para esta devolución.',409,'INSUFFICIENT_CASH')
    const sale = saleResult.rows[0]
    if (refund.restock) await lockPostgresRefundProducts(client, refundId)
    const itemResult = await client.query('SELECT * FROM refund_items WHERE refund_id=$1 ORDER BY item_name FOR UPDATE', [refundId])
    if (refund.restock) {
      for (const line of itemResult.rows) {
        if (!line.item_id) continue
        const updated = await client.query('UPDATE items SET quantity=quantity+$2, updated_at=NOW() WHERE id=$1 RETURNING quantity,name', [line.item_id, line.quantity])
        if (!updated.rows[0]) continue
        await client.query('UPDATE refund_items SET restocked=TRUE WHERE id=$1', [line.id])
        await client.query(
          `INSERT INTO movements (id, item_id, item_name, type, quantity, balance_after, note, sale_id)
           VALUES ($1,$2,$3,'stock_in',$4,$5,$6,$7)`,
          [crypto.randomUUID(), line.item_id, line.item_name, line.quantity, updated.rows[0].quantity,
            `Refund #${shortId(refundId)} — stock restored`, refund.sale_id],
        )
      }
    }
    await client.query(
      `UPDATE refunds SET status='processed', mp_refund_id=$2, mp_status=$3, error_detail='',
       processed_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [refundId, mpRefundId, mpStatus],
    )
    if (refund.credit_note_required) {
      await client.query(
        `INSERT INTO tax_documents (
          id, sale_id, refund_id, type, status, mode, original_document_type, original_folio
        ) VALUES ($1,$2,$3,'credit_note','pending','manual',$4,$5)
        ON CONFLICT (refund_id) DO NOTHING`,
        [crypto.randomUUID(), refund.sale_id, refundId, refund.original_document_type, refund.original_folio],
      )
    }
    const totalResult = await client.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM refunds WHERE sale_id=$1 AND status='processed'`,
      [refund.sale_id],
    )
    const fullyRefunded = Number(totalResult.rows[0].total) >= Number(sale.total)
    await client.query(
      `UPDATE sales SET status=$2, mp_status=COALESCE($3,mp_status), mp_status_detail=COALESCE($4,mp_status_detail), updated_at=NOW() WHERE id=$1`,
      [refund.sale_id, fullyRefunded ? 'refunded' : 'paid', order?.status || null, order?.status_detail || null],
    )
    await client.query('COMMIT')
    return getSale(refund.sale_id)
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function resolveRefundInventoryReview(saleId, refundId, restock) {
  if (!pool) return mutateFileData((data) => {
    const sale = data.sales.find((entry) => entry.id === saleId)
    const refund = sale?.refunds.find((entry) => entry.id === refundId)
    if (!refund) return null
    if (refund.inventoryReviewStatus === 'resolved') return normalizeSale(sale)
    if (refund.status !== 'processed' || refund.source !== 'point_terminal') {
      throw refundConflict('This refund does not have a pending inventory review.')
    }
    if (restock && !refund.items.length) throw refundConflict('Select the returned products manually for a partial Point refund.')
    const now = new Date().toISOString()
    if (restock) {
      for (const line of refund.items) {
        if (line.restocked) continue
        const item = data.items.find((entry) => entry.id === line.itemId)
        if (!item) continue
        item.quantity = Number(item.quantity) + Number(line.quantity)
        item.updatedAt = now
        line.restocked = true
        data.movements.unshift({
          id: crypto.randomUUID(), itemId: item.id, itemName: item.name, saleId, type: 'stock_in',
          quantity: Number(line.quantity), balanceAfter: item.quantity,
          note: `Point refund #${shortId(refund.id)} — stock restored`, createdAt: now,
        })
      }
    }
    refund.restock = Boolean(restock)
    refund.inventoryReviewStatus = 'resolved'
    refund.updatedAt = now
    sale.updatedAt = now
    return normalizeSale(sale)
  })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT id FROM sales WHERE id=$1 FOR UPDATE', [saleId])
    const refundResult = await client.query(
      `SELECT * FROM refunds WHERE id=$1 AND sale_id=$2 FOR UPDATE`,
      [refundId, saleId],
    )
    const refund = refundResult.rows[0]
    if (!refund) { await client.query('ROLLBACK'); return null }
    if (refund.inventory_review_status === 'resolved') { await client.query('COMMIT'); return getSale(saleId) }
    if (refund.status !== 'processed' || refund.source !== 'point_terminal') {
      throw refundConflict('This refund does not have a pending inventory review.')
    }
    if (restock) await lockPostgresRefundProducts(client, refundId)
    const itemResult = await client.query('SELECT * FROM refund_items WHERE refund_id=$1 ORDER BY item_name FOR UPDATE', [refundId])
    if (restock && !itemResult.rows.length) throw refundConflict('Select the returned products manually for a partial Point refund.')
    if (restock) {
      for (const line of itemResult.rows) {
        if (line.restocked || !line.item_id) continue
        const updated = await client.query(
          'UPDATE items SET quantity=quantity+$2,updated_at=NOW() WHERE id=$1 RETURNING quantity',
          [line.item_id, line.quantity],
        )
        if (!updated.rows[0]) continue
        await client.query('UPDATE refund_items SET restocked=TRUE WHERE id=$1', [line.id])
        await client.query(
          `INSERT INTO movements (id,item_id,item_name,type,quantity,balance_after,note,sale_id)
           VALUES ($1,$2,$3,'stock_in',$4,$5,$6,$7)`,
          [crypto.randomUUID(), line.item_id, line.item_name, line.quantity, updated.rows[0].quantity,
            `Point refund #${shortId(refundId)} — stock restored`, saleId],
        )
      }
    }
    await client.query(
      `UPDATE refunds SET restock=$2,inventory_review_status='resolved',updated_at=NOW() WHERE id=$1`,
      [refundId, Boolean(restock)],
    )
    await client.query('COMMIT')
    return getSale(saleId)
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function failRefund(refundId, detail) {
  const message = String(detail || 'refund_failed').slice(0, 500)
  if (!pool) {
    return mutateFileData((data) => {
      const sale = data.sales.find((entry) => entry.refunds.some((refund) => refund.id === refundId))
      if (!sale) return null
      const refund = sale.refunds.find((entry) => entry.id === refundId)
      if (refund.status === 'pending') Object.assign(refund, { status: 'failed', errorDetail: message, updatedAt: new Date().toISOString() })
      return normalizeSale(sale)
    })
  }
  const { rows } = await pool.query(
    `UPDATE refunds SET status='failed', error_detail=$2, updated_at=NOW() WHERE id=$1 AND status='pending' RETURNING sale_id`,
    [refundId, message],
  )
  return rows[0] ? getSale(rows[0].sale_id) : null
}

export async function recordCreditNote(saleId, refundId, input) {
  if (!pool) {
    return mutateFileData((data) => {
      const sale = data.sales.find((entry) => entry.id === saleId)
      const refund = sale?.refunds.find((entry) => entry.id === refundId)
      if (!refund || refund.status !== 'processed') return null
      const now = new Date().toISOString()
      refund.creditNote = {
        ...(refund.creditNote || { id: crypto.randomUUID(), createdAt: now }),
        status: 'issued', mode: 'manual', originalDocumentType: input.originalDocumentType,
        originalFolio: input.originalFolio, folio: input.folio, siiTrackId: input.siiTrackId,
        errorDetail: '', updatedAt: now, issuedAt: now,
      }
      refund.creditNoteRequired = true
      return normalizeSale(sale)
    })
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT id FROM sales WHERE id=$1 FOR UPDATE', [saleId])
    const refundResult = await client.query('SELECT * FROM refunds WHERE id=$1 AND sale_id=$2 AND status=\'processed\' FOR UPDATE', [refundId, saleId])
    if (!refundResult.rows[0]) { await client.query('ROLLBACK'); return null }
    await client.query(
      `INSERT INTO tax_documents (
        id, sale_id, refund_id, type, status, mode, original_document_type, original_folio,
        folio, sii_track_id, issued_at, updated_at
      ) VALUES ($1,$2,$3,'credit_note','issued','manual',$4,$5,$6,$7,NOW(),NOW())
      ON CONFLICT (refund_id) DO UPDATE SET
        status='issued', mode='manual', original_document_type=EXCLUDED.original_document_type,
        original_folio=EXCLUDED.original_folio, folio=EXCLUDED.folio,
        sii_track_id=EXCLUDED.sii_track_id, error_detail='', issued_at=NOW(), updated_at=NOW()`,
      [crypto.randomUUID(), saleId, refundId, input.originalDocumentType, input.originalFolio, input.folio, input.siiTrackId],
    )
    await client.query(
      `UPDATE refunds SET credit_note_required=TRUE, original_document_type=$2, original_folio=$3, updated_at=NOW() WHERE id=$1`,
      [refundId, input.originalDocumentType, input.originalFolio],
    )
    await client.query('COMMIT')
    return getSale(saleId)
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function hydratePostgresSales(rows, queryable = pool) {
  if (!rows.length) return []
  const saleIds = rows.map((row) => row.id)
  const queries = [
    'SELECT * FROM sale_items WHERE sale_id = ANY($1::uuid[]) ORDER BY item_name',
    'SELECT * FROM refunds WHERE sale_id = ANY($1::uuid[]) ORDER BY created_at DESC',
    'SELECT * FROM tax_documents WHERE sale_id = ANY($1::uuid[]) ORDER BY created_at DESC',
  ]
  const results = queryable === pool ? await Promise.all(queries.map(sql => queryable.query(sql, [saleIds]))) : []
  if (queryable !== pool) for (const sql of queries) results.push(await queryable.query(sql, [saleIds]))
  const [itemResult, refundResult, taxDocumentResult] = results
  const refundIds = refundResult.rows.map((refund) => refund.id)
  const refundItemResult = refundIds.length
    ? await queryable.query('SELECT * FROM refund_items WHERE refund_id = ANY($1::uuid[]) ORDER BY item_name', [refundIds])
    : { rows: [] }

  const itemsBySale = new Map(saleIds.map((id) => [id, []]))
  const refundsBySale = new Map(saleIds.map((id) => [id, []]))
  const itemsByRefund = new Map(refundIds.map((id) => [id, []]))
  const creditNoteByRefund = new Map(taxDocumentResult.rows.map((document) => [document.refund_id, document]))
  for (const item of itemResult.rows) itemsBySale.get(item.sale_id)?.push(item)
  for (const item of refundItemResult.rows) itemsByRefund.get(item.refund_id)?.push(item)
  for (const refund of refundResult.rows) {
    refundsBySale.get(refund.sale_id)?.push({
      ...refund,
      items: itemsByRefund.get(refund.id) || [],
      creditNote: creditNoteByRefund.get(refund.id) || null,
    })
  }
  return rows.map((row) => normalizeSale(row, itemsBySale.get(row.id) || [], refundsBySale.get(row.id) || []))
}

export async function getSale(id) {
  if (!pool) {
    const data = await readFileData()
    const sale = data.sales.find((entry) => entry.id === id)
    return sale ? normalizeSale(sale) : null
  }
  const saleResult = await pool.query('SELECT * FROM sales WHERE id=$1', [id])
  return saleResult.rows[0] ? (await hydratePostgresSales(saleResult.rows))[0] : null
}

export async function getSaleByCheckoutKey(key) {
  if (!pool) {
    const data = await readFileData()
    const sale = data.sales.find(sale => sale.checkoutKey === key)
    return sale ? normalizeSale(sale) : null
  }
  const result = await pool.query('SELECT * FROM sales WHERE checkout_key=$1', [key])
  return result.rows.length ? (await hydratePostgresSales(result.rows))[0] : null
}

export async function claimPointOrder(saleId, now = Date.now()) {
  // A short durable lease prevents a reload/retry overlapping the original request.
  // An abandoned reservation can be recovered after 30 seconds with the same sale id.
  if (!pool) return mutateFileData(data => {
    const sale = data.sales.find(sale => sale.id === saleId)
    if (!sale || sale.status !== 'pending' || sale.mpOrderId || Number(sale.pointOrderLeaseUntil || 0) > now) return false
    sale.pointOrderLeaseUntil = now + 30000
    return true
  })
  const result = await pool.query(`UPDATE sales SET point_order_lease_until=NOW()+INTERVAL '30 seconds'
    WHERE id=$1 AND status='pending' AND payment_method='card' AND mp_order_id IS NULL
      AND (point_order_lease_until IS NULL OR point_order_lease_until<=NOW()) RETURNING id`, [saleId])
  return result.rowCount === 1
}

export async function getSaleByPointOrder(orderId) {
  if (!pool) {
    const data = await readFileData()
    const sale = data.sales.find((entry) => entry.mpOrderId === orderId)
    return sale ? normalizeSale(sale) : null
  }
  const { rows } = await pool.query('SELECT id FROM sales WHERE mp_order_id=$1 LIMIT 1', [orderId])
  return rows[0] ? getSale(rows[0].id) : null
}

export async function searchSales(input, user = null) {
  const q = cleanHistoryQuery(input)
  if (!pool) {
    const all = (await readFileData()).sales.map(s => normalizeSale(s)).filter(s => (!user||user.role==='admin'||s.cashierId===user.id)&&(!input.sessionId||s.registerSessionId===input.sessionId)&&historyMatches(s, q))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt) || b.id.localeCompare(a.id))
    return { sales: all.slice(q.offset, q.offset + q.limit), total: all.length, hasMore: q.offset + q.limit < all.length }
  }
  const params = [], clauses = []
  const add = (sql, value) => { params.push(value); clauses.push(sql.replace('?', `$${params.length}`)) }
  if(user?.role==='cashier')add('s.cashier_id = ?',user.id)
  if(input.sessionId)add('s.register_session_id = ?',input.sessionId)
  if (q.from) add('s.created_at >= ?', q.from)
  if (q.to) add('s.created_at < ?', q.to)
  if (q.method) add('s.payment_method = ?', q.method)
  if (q.status === 'refunded') clauses.push("(s.status='refunded' OR EXISTS (SELECT 1 FROM refunds r WHERE r.sale_id=s.id AND r.status='processed'))")
  else if (q.status) add('s.status = ?', q.status)
  if (q.search) add("LOWER(REPLACE(s.id::text || ' ' || COALESCE(s.mp_external_reference,''),'-','')) LIKE ? ESCAPE '\\'", `%${q.search.replaceAll('-', '').toLowerCase().replace(/[\\%_]/g, '\\$&')}%`)
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const count = await client.query(`SELECT COUNT(*) AS total FROM sales s ${where}`, params)
    const rows = await client.query(`SELECT s.* FROM sales s ${where} ORDER BY s.created_at DESC,s.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, q.limit, q.offset])
    const sales = await hydratePostgresSales(rows.rows, client), total = Number(count.rows[0].total)
    await client.query('COMMIT')
    return { sales, total, hasMore: q.offset + q.limit < total }
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}

export async function listSales(limit = 50) {
  if (!pool) {
    const data = await readFileData()
    return data.sales.slice(0, limit).map((sale) => normalizeSale(sale))
  }
  const { rows } = await pool.query('SELECT * FROM sales ORDER BY created_at DESC LIMIT $1', [limit])
  return hydratePostgresSales(rows)
}

function saleTimestamp(sale) {
  return new Date(sale.paidAt || sale.createdAt).getTime()
}

function isWithin(sale, from, to) {
  const timestamp = saleTimestamp(sale)
  return timestamp >= from.getTime() && timestamp < to.getTime()
}

const bakeryTimeZone = process.env.BAKERY_TIME_ZONE || 'America/Santiago'
const datePartsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: bakeryTimeZone, year: 'numeric', month: '2-digit', day: '2-digit',
})
const hourFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: bakeryTimeZone, hour: '2-digit', hourCycle: 'h23',
})

function localDateKey(value) {
  const parts = Object.fromEntries(datePartsFormatter.formatToParts(new Date(value)).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function completedSale(sale) {
  return sale.status === 'paid' || sale.status === 'refunded'
}

function summarizeDay(data, now) {
  const businessDate = localDateKey(now)
  const onDay = value => value && localDateKey(value) === businessDate
  const paid = data.sales.filter(sale => completedSale(sale) && onDay(sale.paidAt || sale.createdAt))
  const refunds = data.sales.flatMap(sale => sale.refunds || []).filter(refund => refund.status === 'processed' && onDay(refund.processedAt || refund.updatedAt || refund.createdAt))
  const grossRevenue = paid.reduce((sum, sale) => sum + Number(sale.total), 0)
  const refundedTotal = refunds.reduce((sum, refund) => sum + Number(refund.amount), 0)
  return { businessDate, transactions: paid.length, grossRevenue, refundedTotal, revenue: grossRevenue - refundedTotal }
}

export async function getDailySummary(now = new Date()) {
  if (!pool) return summarizeDay(await readFileData(), now)
  const businessDate = localDateKey(now)
  const { rows: [row] } = await pool.query(`
    WITH bounds AS (
      SELECT $1::date::timestamp AT TIME ZONE $2 AS start_at,
             ($1::date + 1)::timestamp AT TIME ZONE $2 AS end_at
    ), paid AS (
      SELECT COUNT(*) AS transactions, COALESCE(SUM(total), 0) AS gross
      FROM sales, bounds WHERE status IN ('paid','refunded')
        AND COALESCE(paid_at, created_at) >= start_at AND COALESCE(paid_at, created_at) < end_at
    ), returned AS (
      SELECT COALESCE(SUM(amount), 0) AS refunded FROM refunds, bounds
      WHERE status='processed' AND COALESCE(processed_at, updated_at, created_at) >= start_at
        AND COALESCE(processed_at, updated_at, created_at) < end_at
    ) SELECT paid.transactions, paid.gross, returned.refunded FROM paid CROSS JOIN returned
  `, [businessDate, bakeryTimeZone])
  return { businessDate, transactions: Number(row.transactions), grossRevenue: Number(row.gross),
    refundedTotal: Number(row.refunded), revenue: Number(row.gross) - Number(row.refunded) }
}

function refundTimestamp(refund) {
  return new Date(refund.processedAt || refund.updatedAt || refund.createdAt).getTime()
}

function refundIsWithin(refund, from, to) {
  const timestamp = refundTimestamp(refund)
  return refund.status === 'processed' && timestamp >= from.getTime() && timestamp < to.getTime()
}

function refundsWithin(sales, from, to) {
  return sales.flatMap((sale) => sale.refunds
    .filter((refund) => refundIsWithin(refund, from, to))
    .map((refund) => ({ ...refund, paymentMethod: sale.paymentMethod, saleId: sale.id })))
}

function paidSummary(sales, refunds = []) {
  const grossRevenue = sales.reduce((sum, sale) => sum + sale.total, 0)
  const refundedTotal = refunds.reduce((sum, refund) => sum + refund.amount, 0)
  const revenue = grossRevenue - refundedTotal
  const soldItems = sales.reduce((sum, sale) => sum + sale.items.reduce((lineSum, line) => lineSum + line.quantity, 0), 0)
  const refundedItems = refunds.reduce((sum, refund) => sum + refund.items.reduce((lineSum, line) => lineSum + line.quantity, 0), 0)
  const itemsSold = soldItems - refundedItems
  return {
    revenue,
    grossRevenue,
    refundedTotal,
    transactions: sales.length,
    averageTicket: sales.length ? Math.round(revenue / sales.length) : 0,
    itemsSold,
    itemsPerTransaction: sales.length ? Number((itemsSold / sales.length).toFixed(2)) : 0,
  }
}

export function buildSalesMetrics(sales, { from, to, previousFrom, previousTo, todayFrom, todayTo }) {
  const currentSales = sales.filter((sale) => isWithin(sale, from, to))
  const currentPaid = currentSales.filter(completedSale)
  const previousPaid = sales.filter((sale) => completedSale(sale) && isWithin(sale, previousFrom, previousTo))
  const todayPaid = sales.filter((sale) => completedSale(sale) && isWithin(sale, todayFrom, todayTo))
  const currentRefunds = refundsWithin(sales, from, to)
  const previousRefunds = refundsWithin(sales, previousFrom, previousTo)
  const todayRefunds = refundsWithin(sales, todayFrom, todayTo)
  const summary = paidSummary(currentPaid, currentRefunds)
  const previous = paidSummary(previousPaid, previousRefunds)
  const cashPaid = currentPaid.filter((sale) => sale.paymentMethod === 'cash')
  const cardPaid = currentPaid.filter((sale) => sale.paymentMethod === 'card')
  const cashRefunds = currentRefunds.filter((refund) => refund.paymentMethod === 'cash')
  const cardRefunds = currentRefunds.filter((refund) => refund.paymentMethod === 'card')
  const todayCash = todayPaid.filter((sale) => sale.paymentMethod === 'cash')
  const todayCard = todayPaid.filter((sale) => sale.paymentMethod === 'card')
  const todayCashRefunds = todayRefunds.filter((refund) => refund.paymentMethod === 'cash')
  const todayCardRefunds = todayRefunds.filter((refund) => refund.paymentMethod === 'card')
  const dailyMap = new Map()
  const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, revenue: 0, transactions: 0 }))
  const products = new Map()

  for (const sale of currentPaid) {
    const day = localDateKey(sale.paidAt || sale.createdAt)
    const daily = dailyMap.get(day) || { date: day, revenue: 0, transactions: 0 }
    daily.revenue += sale.total
    daily.transactions += 1
    dailyMap.set(day, daily)

    const hour = Number(hourFormatter.format(new Date(sale.paidAt || sale.createdAt)))
    if (hourly[hour]) {
      hourly[hour].revenue += sale.total
      hourly[hour].transactions += 1
    }

    for (const line of sale.items) {
      const key = line.itemId || line.name
      const product = products.get(key) || { itemId: line.itemId || null, name: line.name, quantity: 0, revenue: 0 }
      product.quantity += line.quantity
      product.revenue += line.lineTotal
      products.set(key, product)
    }
  }

  for (const refund of currentRefunds) {
    const timestamp = refund.processedAt || refund.updatedAt || refund.createdAt
    const day = localDateKey(timestamp)
    const daily = dailyMap.get(day) || { date: day, revenue: 0, transactions: 0 }
    daily.revenue -= refund.amount
    dailyMap.set(day, daily)

    const hour = Number(hourFormatter.format(new Date(timestamp)))
    if (hourly[hour]) hourly[hour].revenue -= refund.amount

    for (const line of refund.items) {
      const key = line.itemId || line.name
      const product = products.get(key) || { itemId: line.itemId || null, name: line.name, quantity: 0, revenue: 0 }
      product.quantity -= line.quantity
      product.revenue -= line.lineTotal
      products.set(key, product)
    }
  }

  const topProducts = [...products.values()]
    .filter((product) => product.quantity > 0 || product.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue || b.quantity - a.quantity)
    .slice(0, 8)
    .map((product) => ({ ...product, revenueShare: summary.revenue ? Number(((product.revenue / summary.revenue) * 100).toFixed(1)) : 0 }))

  return {
    summary: {
      ...summary,
      previousRevenue: previous.revenue,
      revenueChangePct: previous.revenue > 0 ? Number((((summary.revenue - previous.revenue) / previous.revenue) * 100).toFixed(1)) : null,
      pendingPoint: currentSales.filter((sale) => sale.paymentMethod === 'card' && sale.status === 'pending').length,
      failedPayments: currentSales.filter((sale) => ['failed', 'cancelled', 'expired'].includes(sale.status)).length,
      refundedTotal: currentRefunds.reduce((sum, refund) => sum + refund.amount, 0),
    },
    paymentMethods: {
      cash: paidSummary(cashPaid, cashRefunds),
      card: paidSummary(cardPaid, cardRefunds),
    },
    daily: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    hourly,
    topProducts,
    today: {
      ...paidSummary(todayPaid, todayRefunds),
      cashRevenue: paidSummary(todayCash, todayCashRefunds).revenue,
      cashTransactions: todayCash.length,
      cardRevenue: paidSummary(todayCard, todayCardRefunds).revenue,
      cardTransactions: todayCard.length,
    },
  }
}

async function listSalesBetween(from, to) {
  if (!pool) {
    const data = await readFileData()
    return data.sales.map((sale) => normalizeSale(sale)).filter((sale) => (
      isWithin(sale, from, to) || sale.refunds.some((refund) => refundIsWithin(refund, from, to))
    ))
  }
  const { rows } = await pool.query(`
    SELECT s.* FROM sales s
    WHERE (COALESCE(s.paid_at, s.created_at) >= $1 AND COALESCE(s.paid_at, s.created_at) < $2)
       OR EXISTS (
         SELECT 1 FROM refunds r
         WHERE r.sale_id=s.id AND r.status='processed' AND r.processed_at >= $1 AND r.processed_at < $2
       )
    ORDER BY s.created_at DESC
  `, [from.toISOString(), to.toISOString()])
  return hydratePostgresSales(rows)
}

export async function getCashClosure(businessDate) {
  if (!pool) {
    const data = await readFileData()
    return normalizeCashClosure(data.cashClosures.find((closure) => closure.businessDate === businessDate))
  }
  const { rows } = await pool.query('SELECT * FROM cash_closures WHERE business_date=$1 LIMIT 1', [businessDate])
  return normalizeCashClosure(rows[0])
}

export async function getSalesMetrics(period) {
  const earliest = new Date(Math.min(period.from.getTime(), period.previousFrom.getTime(), period.todayFrom.getTime()))
  const latest = new Date(Math.max(period.to.getTime(), period.previousTo.getTime(), period.todayTo.getTime()))
  const [sales, cashClosure] = await Promise.all([listSalesBetween(earliest, latest), getCashClosure(period.businessDate)])
  const metrics = buildSalesMetrics(sales, period)
  const { snapshot, history, ...closureSummary } = cashClosure || {}
  return { ...metrics, cashClosure: cashClosure ? closureSummary : null }
}

async function closureSales(period, client) {
  const { rows } = await client.query(`SELECT s.* FROM sales s
    WHERE (COALESCE(s.paid_at,s.created_at) >= $1 AND COALESCE(s.paid_at,s.created_at) < $2)
      OR EXISTS (SELECT 1 FROM refunds r WHERE r.sale_id=s.id AND
        ((r.processed_at >= $1 AND r.processed_at < $2) OR (r.created_at >= $1 AND r.created_at < $2)))
    ORDER BY s.id`, [period.from.toISOString(), period.to.toISOString()])
  return hydratePostgresSales(rows, client)
}
function closureWorkspace(sales, period, existing, entries = []) {
  const live = withCashLedger(buildClosureSummary(sales, period), entries, existing?.snapshot?.cashLedger || existing || {})
  const { history = [], snapshot, ...fields } = existing || {}
  const closure = { ...fields, snapshot: snapshot ? { fingerprint: snapshot.fingerprint } : null }
  return { live, closure: existing ? closure : null, today: businessDateAt(),
    stale: Boolean(existing && (!existing.snapshot || existing.snapshot.fingerprint !== live.fingerprint)),
    revisions: [...history, ...(existing ? [closure] : [])].map(c => ({ revision: c.revision || 1, closedAt: c.closedAt, operator: c.operator || '', note: c.note, exportable: Boolean(c.snapshot) })) }
}
export async function getCashClosureWorkspace(date) {
  const period = closurePeriod(date)
  if (!pool) {
    const data = await readFileData()
    return closureWorkspace(data.sales.map(s => normalizeSale(s)), period,
      normalizeCashClosure(data.cashClosures.find(c => c.businessDate === period.businessDate)), await getRegisterCashStore().entries(null,null,period))
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const sales = await closureSales(period, client)
    const existing = await client.query('SELECT * FROM cash_closures WHERE business_date=$1', [period.businessDate])
    const workspace = closureWorkspace(sales, period, normalizeCashClosure(existing.rows[0]), await getRegisterCashStore().entries(null,client,period))
    await client.query('COMMIT')
    return workspace
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}
export async function getCashClosureRevision(date, revision) {
  closurePeriod(date)
  if (revision != null && (!/^\d+$/.test(String(revision)) || !Number.isSafeInteger(Number(revision)) || Number(revision) < 1)) throw closureError('Selecciona una versión de cierre válida.')
  const latest = await getCashClosure(date)
  if (!latest) throw closureError('Guarda el cierre antes de exportar su PDF.', 404, 'CLOSURE_NOT_FOUND')
  const selected = revision == null ? latest : [...latest.history, latest].find(c => c.revision === Number(revision))
  if (!selected?.snapshot) throw closureError('Este cierre antiguo no contiene el detalle de operaciones. Registra una corrección para generar un PDF detallado.', 409, 'LEGACY_CLOSURE')
  const { history, ...closure } = selected
  return closure
}
export async function saveCashClosure(body) {
  const input = cleanClosureInput(body)
  const period = closurePeriod(input.businessDate)
  const save = async (sales, existing, queryable) => {
    const summary = withCashLedger(buildClosureSummary(sales, period), await getRegisterCashStore().entries(null,queryable,period), existing?.snapshot?.cashLedger || existing || {})
    const closure = createClosure(summary, input, existing)
    const history = existing ? [...existing.history, Object.fromEntries(Object.entries(existing).filter(([key]) => key !== 'history'))] : []
    return { closure, history }
  }
  if (!pool) {
    return mutateFileData(async data => {
      const index = data.cashClosures.findIndex(c => c.businessDate === input.businessDate)
      const { closure, history } = await save(data.sales.map(s => normalizeSale(s)), normalizeCashClosure(data.cashClosures[index]))
      const stored = { ...closure, history }
      if (index >= 0) data.cashClosures[index] = stored
      else data.cashClosures.unshift(stored)
      return closure
    })
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    const existing = await client.query('SELECT * FROM cash_closures WHERE business_date=$1 FOR UPDATE', [input.businessDate])
    const { closure: c, history } = await save(await closureSales(period, client), normalizeCashClosure(existing.rows[0]),client)
    const result = await client.query(`INSERT INTO cash_closures (
      id,business_date,opening_cash,cash_adjustments,counted_cash,cash_sales,card_sales,total_sales,
      expected_cash,difference,transaction_count,note,closed_at,details
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (business_date) DO UPDATE SET opening_cash=EXCLUDED.opening_cash,
      cash_adjustments=EXCLUDED.cash_adjustments,counted_cash=EXCLUDED.counted_cash,cash_sales=EXCLUDED.cash_sales,
      card_sales=EXCLUDED.card_sales,total_sales=EXCLUDED.total_sales,expected_cash=EXCLUDED.expected_cash,
      difference=EXCLUDED.difference,transaction_count=EXCLUDED.transaction_count,note=EXCLUDED.note,
      closed_at=EXCLUDED.closed_at,details=EXCLUDED.details
    WHERE cash_closures.id=EXCLUDED.id RETURNING id`,
    [c.id,c.businessDate,c.openingCash,c.cashAdjustments,c.countedCash,c.cashSales,c.cardSales,c.totalSales,
      c.expectedCash,c.difference,c.transactionCount,c.note,c.closedAt,JSON.stringify({ current: c, history })])
    if (!result.rows.length) throw closureError('Otro usuario guardó el cierre. Actualiza el día antes de continuar.', 409, 'CLOSURE_CHANGED')
    await client.query('COMMIT')
    return c
  } catch (error) {
    await client.query('ROLLBACK')
    if (['40001','40P01','23505'].includes(error.code)) throw closureError('El día cambió mientras se cerraba. Actualiza y revisa el cierre.', 409, 'CLOSURE_CHANGED')
    throw error
  } finally { client.release() }
}

export async function listMovements(limit = 50) {
  if (pool) {
    const { rows } = await pool.query('SELECT * FROM movements ORDER BY created_at DESC LIMIT $1', [limit])
    return rows.map(normalizeMovement)
  }
  const data = await readFileData()
  return data.movements.slice(0, limit).map(normalizeMovement)
}

function normalizeRegister(row) {
  return row ? { id:row.id,userId:row.user_id??row.userId,operator:row.operator,openingCash:Number(row.opening_cash??row.openingCash),
    additionalCash:Number(row.opening_extra_cash??row.additionalCash??0),sourceSessionId:row.opening_source_session_id??row.sourceSessionId??null,
    openedAt:row.opened_at??row.openedAt,closedAt:row.closed_at??row.closedAt??null,closure:row.closure||null } : null
}
export async function listRegisterSessions(user) {
  const rows=pool?(await pool.query(`SELECT id,user_id,operator,opening_cash,opened_at,closed_at,CASE WHEN closure IS NULL THEN NULL ELSE jsonb_build_object('revision',closure->'revision','closedAt',closure->'closedAt','totalSales',closure->'totalSales') END AS closure FROM register_sessions ${user.role==='admin'?'':'WHERE user_id=$1'} ORDER BY opened_at DESC LIMIT 100`,user.role==='admin'?[]:[user.id])).rows:(await readFileData()).registerSessions.filter(s=>user.role==='admin'||s.userId===user.id).sort((a,b)=>new Date(b.openedAt)-new Date(a.openedAt)).slice(0,100)
  return rows.map(row=>{const s=normalizeRegister(row);return {...s,closure:s.closure?{revision:s.closure.revision,closedAt:s.closure.closedAt,totalSales:s.closure.totalSales}:null}})
}
export async function getActiveRegisterSession(user) {
  return normalizeRegister(pool?(await pool.query('SELECT * FROM register_sessions WHERE user_id=$1 AND closed_at IS NULL',[user.id])).rows[0]:(await readFileData()).registerSessions.find(s=>s.userId===user.id&&!s.closedAt))
}
function openingFrom(row) {
  const previous = normalizeRegister(row)
  return { openingCash: Number(previous?.closure?.countedCash ?? 0), previousSessionId: previous?.id || null,
    previousRevision: previous?.closure?.revision || 0, previousClosedAt: previous?.closedAt || null }
}
const previousRegister = data => (user => data.registerSessions.filter(s=>s.userId===user.id&&s.closedAt&&s.closure)
  .sort((a,b)=>new Date(b.closedAt)-new Date(a.closedAt)||b.id.localeCompare(a.id))[0])
export async function getRegisterOpening(user) {
  return openingFrom(pool ? (await pool.query('SELECT * FROM register_sessions WHERE user_id=$1 AND closed_at IS NOT NULL AND closure IS NOT NULL ORDER BY closed_at DESC,id DESC LIMIT 1',[user.id])).rows[0]
    : previousRegister(await readFileData())(user))
}
export async function openRegisterSession(user,input) {
  const body = typeof input === 'number' ? { openingCash: input } : input || {}
  const build = previous => {
    const context = openingFrom(previous)
    if ('previousSessionId' in body && (body.previousSessionId !== context.previousSessionId || body.previousRevision !== context.previousRevision)) throw userError('El cierre anterior cambió. Actualiza el fondo inicial.',409,'OPENING_CHANGED')
    const base = cashAmount(body.openingCash ?? context.openingCash,'el fondo anterior')
    const additionalCash = cashAmount(body.additionalCash ?? 0,'el efectivo adicional')
    const openingCash = cashAmount(base+additionalCash,'el fondo inicial')
    return {id:crypto.randomUUID(),userId:user.id,operator:user.name,openingCash,additionalCash,sourceSessionId:context.previousSessionId,openedAt:new Date().toISOString(),closedAt:null,closure:null}
  }
  if(!pool)return mutateFileData(data=>{
    const old=data.registerSessions.find(s=>s.userId===user.id&&!s.closedAt)
    if(old)return normalizeRegister(old)
    const next=build(previousRegister(data)(user));data.registerSessions.unshift(next);return next
  })
  const client=await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['register:'+user.id])
    const old=(await client.query('SELECT * FROM register_sessions WHERE user_id=$1 AND closed_at IS NULL',[user.id])).rows[0]
    if(old){await client.query('COMMIT');return normalizeRegister(old)}
    const previous=(await client.query('SELECT * FROM register_sessions WHERE user_id=$1 AND closed_at IS NOT NULL AND closure IS NOT NULL ORDER BY closed_at DESC,id DESC LIMIT 1 FOR UPDATE',[user.id])).rows[0]
    const next=build(previous)
    const {rows}=await client.query(`INSERT INTO register_sessions(id,user_id,operator,opening_cash,opening_extra_cash,opening_source_session_id)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[next.id,user.id,user.name,next.openingCash,next.additionalCash,next.sourceSessionId])
    await client.query('COMMIT');return normalizeRegister(rows[0])
  }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}
function ownedRegister(row,user) {const s=normalizeRegister(row);if(!s||(user.role!=='admin'&&s.userId!==user.id))throw userError('Sesión de caja no encontrada.',404);return s}
function sessionSummary(sales,session) {
  const period={businessDate:businessDateAt(session.openedAt),timeZone:process.env.BAKERY_TIME_ZONE||'America/Santiago',from:new Date(session.openedAt),to:new Date('9999-12-31T23:59:59Z')}
  const summary=buildClosureSummary(sales,period)
  summary.to=session.closedAt||null;summary.scope='session';summary.registerSessionId=session.id
  const {fingerprint,...values}=summary
  summary.fingerprint=crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex')
  return summary
}
async function sessionSales(id,client=pool) {return hydratePostgresSales((await client.query('SELECT * FROM sales WHERE register_session_id=$1 ORDER BY id',[id])).rows,client)}
export function getRegisterCashStore() {
  return createRegisterCashStore({pool,readFileData,mutateFileData,normalizeRegister,sessionSales,sessionSummary})
}
export async function getRegisterClosure(user,id,full=false) {
  const reader=pool?await pool.connect():null
  try {
    if(reader)await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const data=reader?null:await readFileData()
    const session=ownedRegister(reader?(await reader.query('SELECT * FROM register_sessions WHERE id=$1',[id])).rows[0]:data.registerSessions.find(s=>s.id===id),user)
    const sales=session.closedAt?[]:reader?await sessionSales(id,reader):data.sales.filter(s=>s.registerSessionId===id).map(s=>normalizeSale(s))
    const live=session.closedAt?session.closure.snapshot:withCashLedger(sessionSummary(sales,session),await getRegisterCashStore().entries(id,reader||data))
    const {history=[],snapshot,...fields}=session.closure||{}
    if(reader)await reader.query('COMMIT')
    return {session:full?session:{...session,closure:session.closure?{revision:session.closure.revision}:null},live,closure:session.closure?{...fields,snapshot:{fingerprint:snapshot.fingerprint}}:null,today:businessDateAt(),stale:false,
      revisions:[...history,...(session.closure?[session.closure]:[])].map(c=>({revision:c.revision,closedAt:c.closedAt,operator:c.operator,note:c.note,exportable:true}))}
  }catch(e){if(reader)await reader.query('ROLLBACK');throw e}finally{reader?.release()}
}
export async function saveRegisterClosure(user,id,body) {
  const make=(session,sales,entries)=>{
    if(session.closedAt&&user.role!=='admin')throw userError('Esta sesión ya está cerrada.',409,'SESSION_CLOSED')
    const summary=session.closedAt?session.closure.snapshot:withCashLedger(sessionSummary(sales,session),entries)
    if(summary.pendingCount)throw userError('Resuelve los cobros pendientes antes de cerrar la sesión.',409,'PENDING_PAYMENTS')
    const input=cleanClosureInput({...body,businessDate:summary.businessDate,openingCash:session.openingCash,operator:session.operator})
    const result=createClosure(summary,input,session.closure)
    result.scope='session';result.registerSessionId=id;result.userId=session.userId;result.openedAt=session.openedAt;result.closedBy=user.id
    result.additionalCash=session.additionalCash;result.sourceSessionId=session.sourceSessionId
    result.history=session.closure?[...(session.closure.history||[]),Object.fromEntries(Object.entries(session.closure).filter(([k])=>k!=='history'))]:[]
    return result
  }
  if(!pool)return mutateFileData(async data=>{const s=ownedRegister(data.registerSessions.find(s=>s.id===id),user),closure=make(s,data.sales.filter(s=>s.registerSessionId===id).map(s=>normalizeSale(s)),await getRegisterCashStore().entries(id));const row=data.registerSessions.find(s=>s.id===id);row.closedAt ||= closure.closedAt;row.closure=closure;return closure})
  const client=await pool.connect()
  try {await client.query('BEGIN');const session=ownedRegister((await client.query('SELECT * FROM register_sessions WHERE id=$1 FOR UPDATE',[id])).rows[0],user),closure=make(session,await sessionSales(id,client),await getRegisterCashStore().entries(id,client));await client.query('UPDATE register_sessions SET closed_at=COALESCE(closed_at,$2),closure=$3 WHERE id=$1',[id,closure.closedAt,JSON.stringify(closure)]);await client.query('COMMIT');return closure}catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}
export async function getRegisterClosureRevision(user,id,revision) {
  const {session}=await getRegisterClosure(user,id,true),latest=session.closure
  if(!latest)throw userError('Guarda el cierre antes de exportar.',404)
  const selected=[...(latest.history||[]),latest].find(c=>c.revision===Number(revision))
  if(!selected)throw userError('Versión no encontrada.',404)
  return selected
}

export async function countUsers() {
  return pool ? Number((await pool.query('SELECT COUNT(*) AS n FROM app_users')).rows[0].n) : (await readFileData()).users.length
}
export async function getLoginUser(username) {
  return pool ? (await pool.query('SELECT * FROM app_users WHERE username=$1', [username])).rows[0] : (await readFileData()).users.find(u=>u.username===username)
}
export async function listUsers() {
  return (pool ? (await pool.query('SELECT * FROM app_users ORDER BY name')).rows : (await readFileData()).users).map(publicUser)
}
async function insertUser(input, first = false) {
  if (!pool) return mutateFileData(data=>{
    if (first && data.users.length) throw userError('El administrador inicial ya existe.',409)
    if (data.users.some(u=>u.username===input.username)) throw userError('Ese usuario ya existe.',409)
    data.users.push(input); return publicUser(input)
  })
  const client=await pool.connect()
  try {
    await client.query('BEGIN'); await client.query("SELECT pg_advisory_xact_lock(hashtextextended('users-management',0))")
    if (first && Number((await client.query('SELECT COUNT(*) AS n FROM app_users')).rows[0].n)) throw userError('El administrador inicial ya existe.',409)
    const {rows}=await client.query('INSERT INTO app_users(id,username,name,role,active,password_hash,must_change_password) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[input.id,input.username,input.name,input.role,input.active,input.passwordHash,input.mustChangePassword])
    await client.query('COMMIT'); return publicUser(rows[0])
  } catch(e) { await client.query('ROLLBACK'); if(e.code==='23505') throw userError('Ese usuario ya existe.',409); throw e } finally {client.release()}
}
async function seedInitialAdmin() {
  if (!process.env.STAFF_PIN || await countUsers()) return
  try { await insertUser({ id:crypto.randomUUID(),username:'admin',name:'Administrador',role:'admin',active:true,passwordHash:await hashPassword(process.env.STAFF_PIN),mustChangePassword:true },true) }
  catch(e) { if(e.status!==409) throw e }
}
export async function createUser(body, first=false) {
  const input=cleanUser({...body,...(first?{role:'admin',active:true}:{})})
  return insertUser({...input,id:crypto.randomUUID(),password:undefined,passwordHash:await hashPassword(input.password),mustChangePassword:!first},first)
}
export async function updateUser(id,body) {
  const input=cleanUser(body,false), passwordHash=input.password?await hashPassword(input.password):null
  if(!pool) return mutateFileData(data=>{
    const user=data.users.find(u=>u.id===id);if(!user)throw userError('Usuario no encontrado.',404)
    if(data.users.some(u=>u.username===input.username&&u.id!==id))throw userError('Ese usuario ya existe.',409)
    if(user.role==='admin'&&user.active&&(!input.active||input.role!=='admin')&&!data.users.some(u=>u.id!==id&&u.role==='admin'&&u.active))throw userError('Debe quedar al menos un administrador activo.',409)
    Object.assign(user,{username:input.username,name:input.name,role:input.role,active:input.active},passwordHash?{passwordHash,mustChangePassword:true}:{})
    data.authSessions=data.authSessions.filter(s=>s.userId!==id);return publicUser(user)
  })
  const client=await pool.connect()
  try {
    await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtextextended('users-management',0))")
    const current=(await client.query('SELECT * FROM app_users WHERE id=$1 FOR UPDATE',[id])).rows[0]
    if(!current)throw userError('Usuario no encontrado.',404)
    if(current.role==='admin'&&current.active&&(!input.active||input.role!=='admin')&&!Number((await client.query("SELECT COUNT(*) AS n FROM app_users WHERE id<>$1 AND active AND role='admin'",[id])).rows[0].n))throw userError('Debe quedar al menos un administrador activo.',409)
    const {rows}=await client.query('UPDATE app_users SET username=$2,name=$3,role=$4,active=$5,password_hash=COALESCE($6,password_hash),must_change_password=CASE WHEN $6 IS NULL THEN must_change_password ELSE TRUE END WHERE id=$1 RETURNING *',[id,input.username,input.name,input.role,input.active,passwordHash])
    await client.query('DELETE FROM auth_sessions WHERE user_id=$1',[id]);await client.query('COMMIT');return publicUser(rows[0])
  }catch(e){await client.query('ROLLBACK');if(e.code==='23505')throw userError('Ese usuario ya existe.',409);throw e}finally{client.release()}
}
export async function setOwnPassword(id,passwordHash) {
  if(!pool)return mutateFileData(data=>{const u=data.users.find(u=>u.id===id&&u.active);if(!u)throw userError('Vuelve a ingresar.',401);u.passwordHash=passwordHash;u.mustChangePassword=false;data.authSessions=data.authSessions.filter(s=>s.userId!==id);return publicUser(u)})
  const client=await pool.connect()
  try {await client.query('BEGIN');const {rows}=await client.query('UPDATE app_users SET password_hash=$2,must_change_password=FALSE WHERE id=$1 AND active RETURNING *',[id,passwordHash]);if(!rows[0])throw userError('Vuelve a ingresar.',401);await client.query('DELETE FROM auth_sessions WHERE user_id=$1',[id]);await client.query('COMMIT');return publicUser(rows[0])}catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}
export async function createLoginSession(userId,tokenHash) {
  const expiresAt=new Date(Date.now()+12*3600000).toISOString()
  if(!pool)return mutateFileData(data=>{if(!data.users.some(u=>u.id===userId&&u.active))throw userError('Usuario desactivado.',401);data.authSessions=data.authSessions.filter(s=>s.expiresAt>new Date().toISOString());data.authSessions.push({tokenHash,userId,expiresAt})})
  await pool.query('DELETE FROM auth_sessions WHERE expires_at<NOW()');const {rowCount}=await pool.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at) SELECT $1,id,$3 FROM app_users WHERE id=$2 AND active',[tokenHash,userId,expiresAt]);if(!rowCount)throw userError('Usuario desactivado.',401)
}
export async function getSessionUser(tokenHash) {
  if(!pool){const data=await readFileData(),s=data.authSessions.find(s=>s.tokenHash===tokenHash&&s.expiresAt>new Date().toISOString());return publicUser(s&&data.users.find(u=>u.id===s.userId&&u.active))}
  return publicUser((await pool.query('SELECT u.* FROM auth_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW() AND u.active',[tokenHash])).rows[0])
}
export async function revokeLoginSession(tokenHash) {
  if(!pool)return mutateFileData(data=>{data.authSessions=data.authSessions.filter(s=>s.tokenHash!==tokenHash)})
  await pool.query('DELETE FROM auth_sessions WHERE token_hash=$1',[tokenHash])
}

export async function closeStore() {
  if (pool) await pool.end()
}
