import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { cashTender, loadCartDraft, saveCartDraft, loadFavorites, saveFavorites, productLabel } from '../src/posWorkspace.js'

test('cash tender is validated before stock changes and survives an idempotent retry', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bakery-ux-cash-'))
  process.env.DATA_PATH = path.join(dir, 'inventory.json'); process.env.SEED_DEMO_DATA = 'false'; delete process.env.DATABASE_URL
  const store = await import(`./store.js?ux=${crypto.randomUUID()}`)
  try {
    await store.initializeStore()
    const item = await store.createItem({ name: 'Efectivo', category: 'Bread', unit: 'pieces', quantity: 20, price: 1500, sellable: true })
    const cart = [{ itemId: item.id, quantity: 2 }], key = crypto.randomUUID()
    for (const value of [2999, -1, 3000.5, '5000', NaN, Infinity]) await assert.rejects(store.createSale(cart, 'cash', crypto.randomUUID(), value), { status: 400 })
    assert.equal((await store.listItems())[0].quantity, 20)
    const results = await Promise.all(Array.from({ length: 4 }, () => store.createSale(cart, 'cash', key, 5000)))
    assert.equal(new Set(results.map(r => r.id)).size, 1)
    assert.equal(results[0].cashReceived, 5000); assert.equal(results[0].cashChange, 2000)
    assert.equal((await store.getSaleByCheckoutKey(key)).cashChange, 2000)
    await assert.rejects(store.createSale(cart, 'cash', key, 10000), { code: 'CHECKOUT_CONFLICT' })
    assert.equal((await store.listItems())[0].quantity, 18)
  } finally { await store.closeStore(); await fs.rm(dir, { recursive: true, force: true }) }
})

test('inventory batches commit atomically, reject stale counts, and never apply a retry twice', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bakery-ux-batch-'))
  process.env.DATA_PATH = path.join(dir, 'inventory.json'); process.env.SEED_DEMO_DATA = 'false'; delete process.env.DATABASE_URL
  const store = await import(`./store.js?ux=${crypto.randomUUID()}`)
  try {
    await store.initializeStore()
    const make = name => store.createItem({ name, category: 'Bread', unit: 'pieces', quantity: 0, price: 1000, sellable: true })
    const a = await make('A'), b = await make('B'), key = crypto.randomUUID()
    const body = { type: 'stock_in', items: [{ itemId: a.id, quantity: 12 }, { itemId: b.id, quantity: 5.5 }] }
    const result = await Promise.all(Array.from({ length: 6 }, () => store.saveInventoryBatch(body, key)))
    assert.equal(result.filter(r => !r.replayed).length, 1)
    assert.deepEqual((await store.listItems()).map(i => i.quantity), [12, 5.5])
    const before = await fs.readFile(process.env.DATA_PATH, 'utf8')
    await assert.rejects(store.saveInventoryBatch({ ...body, items: [body.items[0], { itemId: crypto.randomUUID(), quantity: 1 }] }, crypto.randomUUID()), { code: 'STOCK_CHANGED' })
    await assert.rejects(store.saveInventoryBatch({ type: 'adjustment', items: [{ itemId: a.id, quantity: 0, expectedQuantity: 12 }, { itemId: b.id, quantity: 0, expectedQuantity: 5 }] }, crypto.randomUUID()), { code: 'STOCK_CHANGED' })
    assert.equal(await fs.readFile(process.env.DATA_PATH, 'utf8'), before)
    await assert.rejects(store.saveInventoryBatch({ ...body, note: 'Changed' }, key), { code: 'BATCH_CONFLICT' })
    for (const quantity of [-1, 0, .001, NaN, Infinity]) await assert.rejects(store.saveInventoryBatch({ type: 'stock_in', items: [{ itemId: a.id, quantity }] }, crypto.randomUUID()), { status: 400 })
    await store.saveInventoryBatch({ type: 'adjustment', items: [{ itemId: a.id, quantity: 0, expectedQuantity: 12 }] }, crypto.randomUUID())
    assert.equal((await store.listItems()).find(i => i.id === a.id).quantity, 0)
  } finally { await store.closeStore(); await fs.rm(dir, { recursive: true, force: true }) }
})

test('sales history searches past the bootstrap window and uses Chile calendar boundaries', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bakery-ux-history-'))
  process.env.DATA_PATH = path.join(dir, 'inventory.json'); process.env.SEED_DEMO_DATA = 'false'; delete process.env.DATABASE_URL
  const store = await import(`./store.js?ux=${crypto.randomUUID()}`)
  try {
    await store.initializeStore()
    const sales = Array.from({ length: 83 }, (_, i) => ({ id: crypto.randomUUID(), createdAt: '2026-10-18T02:59:59Z', status: 'paid', paymentMethod: i % 2 ? 'cash' : 'card', total: 1000, items: [], refunds: [] }))
    sales.push({ ...sales[0], id: crypto.randomUUID(), createdAt: '2026-10-18T03:00:00Z' })
    sales[80].refunds = [{ id: crypto.randomUUID(), status: 'processed', amount: 500, items: [] }]
    await fs.writeFile(process.env.DATA_PATH, JSON.stringify({ items: [], movements: [], sales }))
    const first = await store.searchSales({ from: '2026-10-17', to: '2026-10-17', limit: 40 })
    assert.equal(first.total, 83); assert.equal(first.hasMore, true)
    const second = await store.searchSales({ from: '2026-10-17', to: '2026-10-17', limit: 40, offset: 40 })
    assert.equal(new Set([...first.sales, ...second.sales].map(s => s.id)).size, 80)
    assert.equal((await store.searchSales({ search: sales[80].id.replaceAll('-', '').slice(0,8) })).sales[0].id, sales[80].id)
    assert.equal((await store.searchSales({ search: `VENTA-${sales[80].id.replaceAll('-', '').slice(0,12)}` })).total, 1)
    assert.equal((await store.searchSales({ status: 'refunded' })).total, 1)
    assert.equal((await store.searchSales({ from: '2026-10-18', to: '2026-10-18' })).total, 1)
    assert.equal((await store.searchSales({ method: 'cash' })).total, 41)
    await assert.rejects(store.searchSales({ from: '2026-02-30' }), { status: 400 })
  } finally { await store.closeStore(); await fs.rm(dir, { recursive: true, force: true }) }
})

test('drafts survive section changes, expire, tolerate damaged storage, and keep useful product variants', () => {
  const data = new Map(), storage = { getItem: k => data.get(k), setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k) }
  const cart = [{ itemId: 'one', quantity: 2 }]
  saveCartDraft(cart, storage); assert.deepEqual(loadCartDraft(storage), cart)
  saveFavorites(['one','two'], storage); assert.deepEqual(loadFavorites(storage), ['one','two'])
  saveCartDraft([], storage); assert.deepEqual(loadCartDraft(storage), [])
  data.set('bakery-cart-draft', JSON.stringify({ savedAt: Date.now() - 86400001, items: cart })); assert.deepEqual(loadCartDraft(storage), [])
  data.set('bakery-cart-draft', '{'); assert.deepEqual(loadCartDraft(storage), [])
  assert.equal(cashTender(4500, 5000).change, 500); assert.equal(cashTender(4500, '').valid, false); assert.equal(cashTender(4500, 4000).valid, false)
  assert.deepEqual(productLabel('EMPANADA POLLO/QUESO'), { title: 'EMPANADA', variant: 'POLLO/QUESO' })
})
