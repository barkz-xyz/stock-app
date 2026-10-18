import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import pg from 'pg'

const { Client } = pg
const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL
const tables = ['items', 'sales', 'sale_items', 'refunds', 'refund_items', 'tax_documents', 'movements', 'cash_closures']

if (!connectionString) throw new Error('DATABASE_PUBLIC_URL or DATABASE_URL is required.')

const useSsl = !connectionString.includes('railway.internal') && process.env.PGSSLMODE !== 'disable'
const client = new Client({ connectionString, ssl: useSsl ? { rejectUnauthorized: false } : false })
const backup = {
  format: 'bakery-pos-postgres-backup-v1',
  createdAt: new Date().toISOString(),
  tables: {},
}

try {
  await client.connect()
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  for (const table of ['stock_batches','app_users','register_sessions']) if ((await client.query('SELECT to_regclass($1) AS name',[table])).rows[0].name) tables.push(table)
  for (const table of tables) {
    const { rows } = await client.query(`SELECT * FROM ${table} ORDER BY 1`)
    backup.tables[table] = rows
  }
  await client.query('COMMIT')
} catch (error) {
  await client.query('ROLLBACK').catch(() => {})
  throw error
} finally {
  await client.end().catch(() => {})
}

const payload = Buffer.from(JSON.stringify(backup))
const compressed = zlib.gzipSync(payload, { level: 9 })
const digest = crypto.createHash('sha256').update(compressed).digest('hex')
const stamp = backup.createdAt.replaceAll(':', '-').replaceAll('.', '-')
const directory = path.join(process.cwd(), '.backups')
const filePath = path.join(directory, `postgres-${stamp}.json.gz`)
await fs.mkdir(directory, { recursive: true })
await fs.writeFile(filePath, compressed)
await fs.writeFile(`${filePath}.sha256`, `${digest}  ${path.basename(filePath)}\n`)

console.log(JSON.stringify({
  file: filePath,
  sha256: digest,
  compressedBytes: compressed.length,
  rows: Object.fromEntries(tables.map((table) => [table, backup.tables[table].length])),
}, null, 2))
