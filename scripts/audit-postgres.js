import fs from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'

const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_PUBLIC_URL or DATABASE_URL is required.')
const tables = ['items', 'sales', 'sale_items', 'refunds', 'refund_items', 'tax_documents', 'movements', 'cash_closures']
const client = new pg.Client({ connectionString, connectionTimeoutMillis: 15000,
  ssl: !connectionString.includes('railway.internal') && process.env.PGSSLMODE !== 'disable' ? { rejectUnauthorized: false } : false })
try {
  await client.connect()
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  await client.query("SET LOCAL statement_timeout = '15s'")
  const { rows: [database] } = await client.query("SELECT current_setting('server_version') AS version, pg_database_size(current_database())::bigint AS bytes, current_setting('transaction_read_only') AS read_only")
  const counts = {}
  for (const table of tables) counts[table] = (await client.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count
  const { rows: [integrity] } = await client.query(`SELECT
    (SELECT COUNT(*)::int FROM items WHERE quantity < 0 OR price < 0) AS invalid_inventory,
    (SELECT COUNT(*)::int FROM sales s WHERE s.total <> COALESCE((SELECT SUM(line_total) FROM sale_items WHERE sale_id=s.id),0)) AS sale_total_mismatches,
    (SELECT COUNT(*)::int FROM sales s WHERE s.total < COALESCE((SELECT SUM(amount) FROM refunds WHERE sale_id=s.id AND status='processed'),0)) AS over_refunded_sales,
    (SELECT COUNT(*)::int FROM (SELECT sku FROM items WHERE sku <> '' GROUP BY sku HAVING COUNT(*)>1) duplicate_skus) AS duplicate_sku_groups,
    (SELECT COUNT(*)::int FROM sale_items l LEFT JOIN sales s ON s.id=l.sale_id WHERE s.id IS NULL) AS orphan_sale_lines,
    (SELECT COUNT(*)::int FROM refunds r LEFT JOIN sales s ON s.id=r.sale_id WHERE s.id IS NULL) AS orphan_refunds,
    (SELECT COUNT(*)::int FROM sales WHERE status='pending' AND created_at < NOW()-INTERVAL '1 day') AS stale_pending_sales,
    (SELECT COUNT(*)::int FROM refunds WHERE status='pending' AND created_at < NOW()-INTERVAL '1 day') AS stale_pending_refunds,
    (SELECT COUNT(*)::int FROM refunds WHERE inventory_review_status='pending') AS refund_inventory_reviews`)
  const { rows: saleStates } = await client.query('SELECT payment_method, status, COUNT(*)::int AS count FROM sales GROUP BY payment_method,status ORDER BY payment_method,status')
  const { rows: schemas } = await client.query("SELECT table_schema, COUNT(*)::int AS tables FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema') GROUP BY table_schema ORDER BY table_schema")
  const { rows: constraints } = await client.query("SELECT COUNT(*)::int AS count FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated")
  await client.query('COMMIT')
  let local = null
  try {
    const snapshot = JSON.parse(await fs.readFile(path.join(process.cwd(), 'data', 'inventory.json'), 'utf8'))
    local = Object.fromEntries(Object.entries(snapshot).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length]))
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  console.log(JSON.stringify({ database, counts, integrity, unvalidatedConstraints: constraints[0].count, saleStates, schemas, localJsonCounts: local }, null, 2))
} finally {
  await client.query('ROLLBACK').catch(() => {})
  await client.end().catch(() => {})
}
