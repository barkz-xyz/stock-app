import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { setTimeout as delay } from 'node:timers/promises'
import { closeChangeListener, listenForDatabaseChanges, subscribeToChanges } from './changes.js'

// Opt-in integration test: all writes stay in a fresh schema, never business tables.
test('PostgreSQL serializes checkout retries and aggregates the full business day', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const schema = `verify_checkout_${crypto.randomUUID().replaceAll('-', '')}`
  const connectionString = process.env.TEST_DATABASE_URL
  const ssl = !connectionString.includes('railway.internal') && process.env.PGSSLMODE !== 'disable' ? { rejectUnauthorized: false } : false
  const admin = new pg.Client({ connectionString, ssl })
  let store
  const previousUrl = process.env.DATABASE_URL
  try {
    await admin.connect()
    await admin.query(`CREATE SCHEMA "${schema}"`)
    const isolated = new URL(connectionString)
    isolated.searchParams.set('options', `-c search_path=${schema}`)
    process.env.DATABASE_URL = isolated.href
    store = await import(`./store.js?postgres=${crypto.randomUUID()}`)
    await store.initializeStore()
    const item = await store.createItem({ name: 'Isolated retry test', category: 'Bread', unit: 'pieces', quantity: 20, price: 1000, sellable: true, lowStockThreshold: 0, sku: 'ISOLATED', expiryDate: null })
    const key = crypto.randomUUID()
    const cart = [{ itemId: item.id, quantity: 2 }]
    const sales = await Promise.all(Array.from({ length: 8 }, () => store.createSale(cart, 'cash', key)))
    assert.equal(new Set(sales.map(sale => sale.id)).size, 1)
    assert.equal((await store.listItems())[0].quantity, 18)
    assert.equal((await store.listSales()).length, 1)
    await assert.rejects(store.createSale(cart, 'card', key), { code: 'CHECKOUT_CONFLICT' })
    assert.equal((await store.getSaleByCheckoutKey(key)).id, sales[0].id)
    const cardKey = crypto.randomUUID()
    const cards = await Promise.all(Array.from({ length: 4 }, () => store.createSale(cart, 'card', cardKey)))
    assert.equal(new Set(cards.map(sale => sale.id)).size, 1)
    assert.equal((await store.listItems())[0].quantity, 16)
    const claims = await Promise.all(Array.from({ length: 4 }, () => store.claimPointOrder(cards[0].id)))
    assert.equal(claims.filter(Boolean).length, 1)
    await admin.query(`SET search_path TO "${schema}"`)
    await admin.query('UPDATE sales SET point_order_lease_until=NOW()-INTERVAL \'1 second\' WHERE id=$1', [cards[0].id])
    assert.equal(await store.claimPointOrder(cards[0].id), true)
    await admin.query(`INSERT INTO sales (id,status,payment_method,total,paid_at,created_at)
      SELECT gen_random_uuid(),'paid','cash',1000,'2026-10-17T20:00:00Z','2026-10-17T20:00:00Z' FROM generate_series(1,65)`)
    await admin.query(`UPDATE sales SET paid_at='2020-01-01',created_at='2020-01-01' WHERE checkout_key IS NOT NULL`)
    await admin.query(`INSERT INTO refunds (id,sale_id,status,amount,reason,processed_at) VALUES ($1,$2,'processed',500,'isolated test','2026-10-18T02:59:00Z')`, [crypto.randomUUID(), sales[0].id])
    const now = new Date('2026-10-18T02:59:59Z')
    assert.deepEqual(await store.getDailySummary(now), { businessDate: '2026-10-17', transactions: 65, grossRevenue: 65000, refundedTotal: 500, revenue: 64500 })
    const boot = await store.getBootstrapData(now)
    assert.equal(boot.sales.length, 50)
    assert.equal(boot.dailySummary.transactions, 65)
    assert.equal((await store.getDailySummary(new Date('2026-10-18T03:00:00Z'))).transactions, 0)
    await listenForDatabaseChanges(isolated.href)
    let notifications = 0
    const unsubscribe = subscribeToChanges(() => notifications++)
    try {
      await admin.query('BEGIN')
      await admin.query('UPDATE items SET quantity=quantity+1 WHERE id=$1', [item.id])
      await delay(150)
      assert.equal(notifications, 0)
      await admin.query('ROLLBACK')
      await delay(150)
      assert.equal(notifications, 0)
      await admin.query('UPDATE items SET quantity=quantity+1 WHERE id=$1', [item.id])
      for (let attempt = 0; attempt < 20 && !notifications; attempt++) await delay(100)
      assert.ok(notifications > 0, 'Committed changes from another connection reach the listener')
    } finally { unsubscribe(); await closeChangeListener() }
  } finally {
    process.env.DATABASE_URL = previousUrl || ''
    await store?.closeStore()
    // schema is generated above with only a constant prefix and UUID hex characters.
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
    await admin.end()
  }
})
