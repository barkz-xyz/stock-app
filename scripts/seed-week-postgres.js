import { postgresConfig } from '../server/postgres.js'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const { Pool } = pg
const workspace = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const demoPath = path.join(workspace, 'data', 'inventory.json')
const databaseUrl = process.env.DATABASE_URL
const confirmed = process.argv.includes('--yes') && process.argv.includes('--replace-production-demo')

if (!confirmed) {
  console.error('Refusing to replace PostgreSQL data without both confirmations.')
  console.error('Run: npm run seed:week:postgres -- --yes --replace-production-demo')
  process.exit(1)
}
if (!databaseUrl) {
  console.error('DATABASE_URL is required. Run this through Railway or provide a PostgreSQL connection string.')
  process.exit(1)
}

const generatorEnvironment = { ...process.env }
delete generatorEnvironment.DATABASE_URL
delete generatorEnvironment.DATA_PATH
execFileSync(process.execPath, [path.join(workspace, 'scripts', 'seed-week-demo.js'), '--yes'], {
  cwd: workspace,
  env: generatorEnvironment,
  stdio: 'inherit',
})

const demo = JSON.parse(await fs.readFile(demoPath, 'utf8'))
const pool = new Pool(postgresConfig(databaseUrl))
const client = await pool.connect()
let transactionStarted = false

function backupName(table, suffix) {
  const identifier = `${table}_${suffix}`
  if (!/^[a-z][a-z0-9_]+$/.test(identifier)) throw new Error(`Unsafe backup identifier: ${identifier}`)
  return `bakery_demo_backups."${identifier}"`
}

try {
  await client.query('BEGIN')
  transactionStarted = true
  await client.query('SELECT pg_advisory_xact_lock($1)', [7720260730])

  const requiredTables = ['items', 'sales', 'sale_items', 'movements', 'cash_closures']
  const tableCheck = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_name = ANY($1::text[])`,
    [requiredTables],
  )
  const existingTables = new Set(tableCheck.rows.map((row) => row.table_name))
  const missingTables = requiredTables.filter((table) => !existingTables.has(table))
  if (missingTables.length) throw new Error(`Database schema is not initialized. Missing: ${missingTables.join(', ')}`)

  const before = {}
  for (const table of requiredTables) {
    const result = await client.query(`SELECT COUNT(*)::integer AS count FROM ${table}`)
    before[table] = result.rows[0].count
  }

  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)
  const suffix = `b${stamp}_${crypto.randomBytes(2).toString('hex')}`
  await client.query('CREATE SCHEMA IF NOT EXISTS bakery_demo_backups')
  for (const table of requiredTables) {
    await client.query(`CREATE TABLE ${backupName(table, suffix)} AS TABLE ${table}`)
  }

  await client.query('TRUNCATE movements, sale_items, sales, items, cash_closures')

  for (const item of demo.items) {
    await client.query(
      `INSERT INTO items (
        id, name, category, unit, quantity, low_stock_threshold, sku, expiry_date,
        price, sellable, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [item.id, item.name, item.category, item.unit, item.quantity, item.lowStockThreshold, item.sku,
        item.expiryDate, item.price, item.sellable, item.createdAt, item.updatedAt],
    )
  }

  for (const sale of demo.sales) {
    await client.query(
      `INSERT INTO sales (
        id, status, payment_method, total, mp_order_id, mp_payment_id, mp_status,
        mp_status_detail, inventory_applied, created_at, updated_at, paid_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [sale.id, sale.status, sale.paymentMethod, sale.total, sale.mpOrderId, sale.mpPaymentId,
        sale.mpStatus, sale.mpStatusDetail, sale.inventoryApplied, sale.createdAt, sale.updatedAt, sale.paidAt],
    )
    for (const line of sale.items) {
      await client.query(
        `INSERT INTO sale_items (
          id, sale_id, item_id, item_name, unit, quantity, unit_price, line_total
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [crypto.randomUUID(), sale.id, line.itemId, line.name, line.unit, line.quantity, line.unitPrice, line.lineTotal],
      )
    }
  }

  for (const movement of demo.movements) {
    await client.query(
      `INSERT INTO movements (
        id, item_id, item_name, type, quantity, balance_after, note, sale_id, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [movement.id, movement.itemId, movement.itemName, movement.type, movement.quantity,
        movement.balanceAfter, movement.note, movement.saleId, movement.createdAt],
    )
  }

  for (const closure of demo.cashClosures) {
    await client.query(
      `INSERT INTO cash_closures (
        id, business_date, opening_cash, cash_adjustments, counted_cash, cash_sales, card_sales,
        total_sales, expected_cash, difference, transaction_count, note, closed_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [closure.id, closure.businessDate, closure.openingCash, closure.cashAdjustments, closure.countedCash,
        closure.cashSales, closure.cardSales, closure.totalSales, closure.expectedCash, closure.difference,
        closure.transactionCount, closure.note, closure.closedAt],
    )
  }

  const verification = await client.query(`
    SELECT
      (SELECT COUNT(*)::integer FROM items) AS products,
      (SELECT COUNT(*)::integer FROM sales) AS sales,
      (SELECT COUNT(*)::integer FROM sales WHERE status='paid') AS paid_sales,
      (SELECT COALESCE(SUM(total),0)::bigint FROM sales WHERE status='paid') AS revenue,
      (SELECT COUNT(*)::integer FROM movements) AS movements,
      (SELECT COUNT(*)::integer FROM cash_closures) AS cash_closures
  `)
  const result = verification.rows[0]
  if (result.products !== demo.items.length || result.sales !== demo.sales.length || result.movements !== demo.movements.length) {
    throw new Error('PostgreSQL verification counts do not match the generated demo.')
  }

  await client.query('COMMIT')
  transactionStarted = false
  console.log(JSON.stringify({
    database: 'PostgreSQL',
    backupSchema: 'bakery_demo_backups',
    backupSuffix: suffix,
    previousRows: before,
    seeded: {
      products: result.products,
      sales: result.sales,
      paidSales: result.paid_sales,
      revenue: Number(result.revenue),
      movements: result.movements,
      cashClosures: result.cash_closures,
    },
  }, null, 2))
} catch (error) {
  if (transactionStarted) await client.query('ROLLBACK')
  throw error
} finally {
  client.release()
  await pool.end()
}
