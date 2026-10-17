import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import pg from 'pg'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const tables = ['items', 'sales', 'sale_items', 'refunds', 'refund_items', 'tax_documents', 'movements', 'cash_closures']

export function validateCatalog(catalog) {
  assert.equal(catalog.source?.sheet, 'ProductosPrecios')
  assert.ok(Array.isArray(catalog.products) && catalog.products.length > 0)
  const names = new Set()
  const skus = new Set()
  for (const product of catalog.products) {
    assert.ok(typeof product.name === 'string' && product.name.trim())
    assert.ok(Number.isInteger(product.price) && product.price > 0, `Invalid price for ${product.name}`)
    assert.ok(!names.has(product.name) && !skus.has(product.sku), 'Duplicate product name or SKU')
    names.add(product.name)
    skus.add(product.sku)
  }
  return catalog.products
}

function newProducts(products) {
  const now = new Date().toISOString()
  return products.map((product) => ({
    id: crypto.randomUUID(), name: product.name, category: product.category, unit: product.unit,
    quantity: 0, lowStockThreshold: 0, sku: product.sku, expiryDate: null, price: product.price,
    sellable: true, createdAt: now, updatedAt: now,
  }))
}

export function replaceLocalCatalog(data, products) {
  const result = structuredClone(data)
  result.items = newProducts(products)
  result.movements = []
  for (const sale of result.sales || []) {
    for (const line of sale.items || []) line.itemId = null
    for (const refund of sale.refunds || []) {
      for (const line of refund.items || []) line.itemId = null
    }
  }
  return result
}

async function backup(label, payload) {
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const directory = path.join(root, '.backups')
  await fs.mkdir(directory, { recursive: true })
  const file = path.join(directory, `${label}-before-catalog-${stamp}.json.gz`)
  const bytes = zlib.gzipSync(Buffer.from(payload), { level: 9 })
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  await fs.writeFile(file, bytes, { flag: 'wx' })
  await fs.writeFile(`${file}.sha256`, `${sha256}  ${path.basename(file)}\n`, { flag: 'wx' })
  return { file, sha256 }
}

function verifyProducts(actual, expected) {
  assert.equal(actual.length, expected.length)
  const wanted = new Map(expected.map((product) => [product.sku, product]))
  for (const product of actual) {
    const expectedProduct = wanted.get(product.sku)
    assert.ok(expectedProduct, `Unexpected SKU ${product.sku}`)
    assert.equal(product.name, expectedProduct.name)
    assert.equal(Number(product.price), expectedProduct.price)
    assert.equal(Number(product.quantity), 0)
    assert.equal(product.sellable, true)
    wanted.delete(product.sku)
  }
  assert.equal(wanted.size, 0)
}

async function replaceJson(products, apply) {
  assert.ok(!process.env.DATABASE_URL, 'Local JSON import must not have DATABASE_URL configured.')
  const target = path.join(root, 'data', 'inventory.json')
  const original = await fs.readFile(target, 'utf8')
  const data = JSON.parse(original)
  const summary = { target: 'local', oldProducts: data.items.length, newProducts: products.length,
    salesRetained: data.sales?.length || 0, refundsRetained: (data.sales || []).reduce((sum, sale) => sum + (sale.refunds?.length || 0), 0) }
  if (!apply) return { ...summary, dryRun: true }
  const saved = await backup('local', original)
  const next = replaceLocalCatalog(data, products)
  verifyProducts(next.items, products)
  assert.deepEqual(next.cashClosures, data.cashClosures)
  // Refuse to overwrite a file changed by the running app while preparing the import.
  assert.equal(await fs.readFile(target, 'utf8'), original, 'Local data changed during import; retry from a fresh backup.')
  const temporary = `${target}.catalog-${crypto.randomUUID()}.tmp`
  await fs.writeFile(temporary, JSON.stringify(next, null, 2), { flag: 'wx' })
  assert.equal(await fs.readFile(target, 'utf8'), original, 'Local data changed before replacement.')
  await fs.rename(temporary, target)
  const verified = JSON.parse(await fs.readFile(target, 'utf8'))
  verifyProducts(verified.items, products)
  assert.deepEqual(verified.sales, next.sales)
  return { ...summary, applied: true, stock: 0, backup: saved }
}

async function replacePostgres(products, apply) {
  assert.equal(process.env.RAILWAY_PROJECT_ID, '2d51adc4-99a5-4b42-affd-645b5f9d679c', 'Unexpected Railway project.')
  assert.equal(process.env.RAILWAY_ENVIRONMENT_ID, '0f809491-03ae-4601-8430-eda0d38929e8', 'Unexpected Railway environment.')
  assert.equal(process.env.RAILWAY_SERVICE_ID, 'bac0302d-107e-489e-9192-a0232b9f0444', 'Use the Postgres service variables.')
  const connectionString = process.env.DATABASE_PUBLIC_URL
  assert.ok(connectionString)
  const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 })
  let transaction = false
  try {
    await client.connect()
    await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
    transaction = true
    await client.query("SET LOCAL lock_timeout = '5s'")
    await client.query("SET LOCAL statement_timeout = '20s'")
    if (apply) await client.query('LOCK TABLE items, sales, sale_items, refunds, refund_items, movements IN EXCLUSIVE MODE')
    const snapshot = {}
    for (const table of tables) snapshot[table] = (await client.query(`SELECT * FROM ${table} ORDER BY id`)).rows
    assert.ok(!snapshot.sales.some((sale) => sale.status === 'pending'), 'Finish pending production payments before replacing the inventory.')
    assert.ok(!snapshot.refunds.some((refund) => refund.status === 'pending'), 'Finish pending production refunds before replacing the inventory.')
    const summary = { target: 'production', oldProducts: snapshot.items.length, newProducts: products.length,
      salesRetained: snapshot.sales.length, refundsRetained: snapshot.refunds.length }
    if (!apply) {
      await client.query('ROLLBACK')
      transaction = false
      return { ...summary, dryRun: true }
    }
    const saved = await backup('postgres', JSON.stringify({ format: 'bakery-pos-postgres-backup-v1', createdAt: new Date().toISOString(), tables: snapshot }))
    await client.query('DELETE FROM items')
    await client.query('DELETE FROM movements')
    const records = newProducts(products)
    await client.query(`INSERT INTO items (id,name,category,unit,quantity,low_stock_threshold,sku,expiry_date,price,sellable)
      SELECT id,name,category,unit,0,0,sku,NULL,price,TRUE FROM UNNEST(
        $1::uuid[],$2::text[],$3::text[],$4::text[],$5::text[],$6::numeric[]
      ) AS input(id,name,category,unit,sku,price)`, [
      records.map((p) => p.id), records.map((p) => p.name), records.map((p) => p.category),
      records.map((p) => p.unit), records.map((p) => p.sku), records.map((p) => p.price),
    ])
    verifyProducts((await client.query('SELECT * FROM items ORDER BY name')).rows, products)
    for (const table of ['sales', 'refunds', 'tax_documents', 'cash_closures']) {
      assert.deepEqual((await client.query(`SELECT * FROM ${table} ORDER BY id`)).rows, snapshot[table], `${table} history must stay unchanged`)
    }
    for (const table of ['sale_items', 'refund_items']) {
      assert.deepEqual((await client.query(`SELECT * FROM ${table} ORDER BY id`)).rows,
        snapshot[table].map((line) => ({ ...line, item_id: null })), `${table} snapshots must stay unchanged`)
    }
    await client.query('COMMIT')
    transaction = false
    return { ...summary, applied: true, stock: 0, backup: saved }
  } finally {
    if (transaction) await client.query('ROLLBACK').catch(() => {})
    await client.end().catch(() => {})
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const catalog = JSON.parse(await fs.readFile(path.join(root, 'assets', 'productos-precios.json'), 'utf8'))
  const products = validateCatalog(catalog)
  const target = process.argv.find((argument) => argument.startsWith('--target='))?.split('=')[1]
  assert.ok(['local', 'postgres'].includes(target), 'Choose --target=local or --target=postgres. Add --apply only to execute the replacement.')
  console.log(JSON.stringify(await (target === 'local' ? replaceJson : replacePostgres)(products, process.argv.includes('--apply')), null, 2))
}
