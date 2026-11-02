import { postgresConfig } from '../server/postgres.js'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'

const { Client } = pg
const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL

if (!connectionString) throw new Error('DATABASE_PUBLIC_URL or DATABASE_URL is required.')

const client = new Client(postgresConfig(connectionString))

try {
  await client.connect()
  await client.query('BEGIN')
  const itemResult = await client.query(
    'SELECT * FROM items WHERE sellable=TRUE AND price>0 AND quantity>=1 ORDER BY id LIMIT 2 FOR UPDATE',
  )
  if (!itemResult.rows.length) throw new Error('No in-stock sellable product is available for the rollback-only check.')

  const saleId = crypto.randomUUID()
  const lines = itemResult.rows.map((item) => ({
    lineId: crypto.randomUUID(),
    item,
    quantity: 1,
    lineTotal: Number(item.price),
  }))
  await client.query(
    `INSERT INTO sales (id, status, payment_method, total, inventory_applied)
     VALUES ($1,'pending','card',$2,TRUE)`,
    [saleId, lines.reduce((sum, line) => sum + line.lineTotal, 0)],
  )
  await client.query(
    `INSERT INTO sale_items (id, sale_id, item_id, item_name, unit, quantity, unit_price, line_total)
     SELECT * FROM UNNEST(
       $1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::numeric[], $7::numeric[], $8::numeric[]
     )`,
    [
      lines.map((line) => line.lineId), lines.map(() => saleId), lines.map((line) => line.item.id),
      lines.map((line) => line.item.name), lines.map((line) => line.item.unit), lines.map((line) => line.quantity),
      lines.map((line) => line.item.price), lines.map((line) => line.lineTotal),
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
    [lines.map((line) => line.item.id), lines.map((line) => line.quantity)],
  )
  const balances = new Map(updatedItems.rows.map((item) => [item.id, item.quantity]))
  await client.query(
    `INSERT INTO movements (id, item_id, item_name, type, quantity, balance_after, note, sale_id)
     SELECT movement_id, item_id, item_name, 'stock_out', quantity, balance_after, note, sale_id
     FROM UNNEST(
       $1::uuid[], $2::uuid[], $3::text[], $4::numeric[], $5::numeric[], $6::text[], $7::uuid[]
     ) AS batch(movement_id, item_id, item_name, quantity, balance_after, note, sale_id)`,
    [
      lines.map(() => crypto.randomUUID()), lines.map((line) => line.item.id), lines.map((line) => line.item.name),
      lines.map(() => -1), lines.map((line) => balances.get(line.item.id)), lines.map(() => 'Rollback-only verification'),
      lines.map(() => saleId),
    ],
  )

  const { rows: [counts] } = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM sale_items WHERE sale_id=$1) AS sale_items,
       (SELECT COUNT(*)::int FROM movements WHERE sale_id=$1) AS movements`,
    [saleId],
  )
  assert.equal(counts.sale_items, lines.length)
  assert.equal(counts.movements, lines.length)
  assert.equal(updatedItems.rows.length, lines.length)
  console.log(JSON.stringify({ ok: true, checkedProducts: lines.length, rollback: true }))
} finally {
  await client.query('ROLLBACK').catch(() => {})
  await client.end().catch(() => {})
}
