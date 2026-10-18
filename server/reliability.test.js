import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('daily summary includes more than 50 sales, refunds from older sales, and Chilean midnight', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bakery-daily-'))
  process.env.DATA_PATH = path.join(directory, 'inventory.json')
  process.env.SEED_DEMO_DATA = 'false'
  delete process.env.DATABASE_URL
  const store = await import(`./store.js?daily=${crypto.randomUUID()}`)
  try {
    await store.initializeStore()
    const sale = (total, createdAt, status='paid', refunds=[]) => ({ id: crypto.randomUUID(), total, createdAt, paidAt: createdAt, status, paymentMethod: 'cash', items: [], refunds })
    const sales = Array.from({ length: 65 }, () => sale(1000, '2026-10-17T20:00:00Z'))
    sales[0].status = 'refunded'
    sales[0].refunds = [{ id: crypto.randomUUID(), status: 'processed', amount: 500, processedAt: '2026-10-18T02:59:00Z', items: [] }]
    sales.push(sale(2000, '2020-01-01T12:00:00Z', 'paid', [{ id: crypto.randomUUID(), status: 'processed', amount: 1000, processedAt: '2026-10-17T22:00:00Z', items: [] }]))
    sales.push(sale(99999, '2026-10-17T21:00:00Z', 'pending'))
    sales.push(sale(700, '2026-10-18T03:00:00Z'))
    await fs.writeFile(process.env.DATA_PATH, JSON.stringify({ items: [], movements: [], cashClosures: [], sales }))
    const now = new Date('2026-10-18T02:59:59Z')
    assert.deepEqual(await store.getDailySummary(now), { businessDate: '2026-10-17', transactions: 65, grossRevenue: 65000, refundedTotal: 1500, revenue: 63500 })
    const boot = await store.getBootstrapData(now)
    assert.equal(boot.sales.length, 50)
    assert.equal(boot.dailySummary.revenue, 63500)
    assert.equal(boot.dailySummary.transactions, 65)
    assert.deepEqual(await store.getDailySummary(new Date('2026-10-18T03:00:00Z')), { businessDate: '2026-10-18', transactions: 1, grossRevenue: 700, refundedTotal: 0, revenue: 700 })
  } finally { await store.closeStore(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('checkout keys survive reload, concurrent retries, depleted stock, and cancelled card reservations', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bakery-checkout-'))
  process.env.DATA_PATH = path.join(directory, 'inventory.json')
  process.env.SEED_DEMO_DATA = 'false'
  delete process.env.DATABASE_URL
  const store = await import(`./store.js?checkout=${crypto.randomUUID()}`)
  try {
    await store.initializeStore()
    const item = await store.createItem({ name: 'Retry test', category: 'Bread', unit: 'pieces', quantity: 2, price: 1000, sellable: true })
    const key = crypto.randomUUID()
    const cart = [{ itemId: item.id, quantity: 2 }]
    const results = await Promise.all(Array.from({ length: 8 }, () => store.createSale(cart, 'cash', key)))
    assert.equal(new Set(results.map(sale => sale.id)).size, 1)
    assert.equal((await store.listItems())[0].quantity, 0)
    assert.equal((await store.listSales()).length, 1)
    assert.equal((await store.listMovements()).filter(m => m.type === 'stock_out').length, 1)
    await store.closeStore()
    const reloaded = await import(`./store.js?reload=${crypto.randomUUID()}`)
    await reloaded.initializeStore()
    assert.equal((await reloaded.createSale(cart, 'cash', key)).id, results[0].id)
    assert.equal((await reloaded.getSaleByCheckoutKey(key)).id, results[0].id)
    await assert.rejects(reloaded.createSale([{ itemId: item.id, quantity: 1 }], 'cash', key), { status: 409, code: 'CHECKOUT_CONFLICT' })
    await assert.rejects(reloaded.createSale(cart, 'card', key), { status: 409, code: 'CHECKOUT_CONFLICT' })
    await reloaded.adjustItem(item.id, { type: 'stock_in', quantity: 2, note: 'Test refill' })
    const cardKey = crypto.randomUUID()
    const card = await reloaded.createSale(cart, 'card', cardKey)
    const claims = await Promise.all(Array.from({ length: 8 }, () => reloaded.claimPointOrder(card.id)))
    assert.equal(claims.filter(Boolean).length, 1)
    assert.equal(await reloaded.claimPointOrder(card.id, Date.now() + 31000), true)
    await reloaded.markCardSaleFailed(card.id, 'test')
    assert.equal((await reloaded.createSale(cart, 'card', cardKey)).status, 'failed')
    assert.equal((await reloaded.listItems())[0].quantity, 2)
    await reloaded.closeStore()
  } finally { await store.closeStore(); await fs.rm(directory, { recursive: true, force: true }) }
})
