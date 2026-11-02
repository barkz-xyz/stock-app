import { initializeInventoryRevision } from './inventory-snapshot.js'
import { initializeStockReservations } from './stock-reservations.js'
import { initializeCashLedger } from './cash-ledger.js'
import { createIntegrationStore } from './integration-store.js'

export const databaseSchemaVersion = 2

export async function migrateDatabase(pool) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('bakery-migrations:'||current_schema(),0))")
    await client.query(`
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
        inventory_applied BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        paid_at TIMESTAMPTZ
      );
      ALTER TABLE sales ADD COLUMN IF NOT EXISTS checkout_key UUID;
      ALTER TABLE sales ADD COLUMN IF NOT EXISTS point_payment BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE sales ADD COLUMN IF NOT EXISTS point_tax_condition TEXT CHECK (point_tax_condition IN ('payment_taxable_iva','payment_exempt_iva'));
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
      ALTER TABLE refunds ADD COLUMN IF NOT EXISTS request_key UUID;
      ALTER TABLE refunds ADD COLUMN IF NOT EXISTS requested_by UUID REFERENCES app_users(id);
      ALTER TABLE refunds ADD COLUMN IF NOT EXISTS request_fingerprint TEXT;
      ALTER TABLE refunds ADD COLUMN IF NOT EXISTS provider_full BOOLEAN;
      CREATE UNIQUE INDEX IF NOT EXISTS refunds_request_key_idx ON refunds(request_key) WHERE request_key IS NOT NULL;
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
    await initializeInventoryRevision(client)
    await initializeStockReservations(client)
    await initializeCashLedger(client)
    await createIntegrationStore({ pool: client }).initialize()
    await client.query('CREATE TABLE IF NOT EXISTS bakery_schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())')
    await client.query('INSERT INTO bakery_schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING', [databaseSchemaVersion])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

export async function assertDatabaseSchema(pool) {
  const { rows: [state] } = await pool.query("SELECT to_regclass('bakery_schema_migrations') AS relation")
  if (!state.relation || !(await pool.query('SELECT 1 FROM bakery_schema_migrations WHERE version=$1', [databaseSchemaVersion])).rowCount) {
    throw new Error('Database migrations are required. Run migrate:postgres with MIGRATION_DATABASE_URL before starting the application.')
  }
}
