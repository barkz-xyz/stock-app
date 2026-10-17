import assert from 'node:assert/strict'
import test from 'node:test'
import { replaceLocalCatalog, validateCatalog } from '../scripts/import-sheet-catalog.js'

test('catalog replacement removes old stock and retains sale/refund snapshots', () => {
  const sale = { id: 'sale-1', status: 'refunded', total: 2200,
    items: [{ lineId: 'line-1', itemId: 'old-product', name: 'Old snapshot', quantity: 2, unitPrice: 1100, lineTotal: 2200 }],
    refunds: [{ id: 'refund-1', status: 'processed', amount: 1100,
      items: [{ itemId: 'old-product', saleItemId: 'line-1', name: 'Old snapshot', quantity: 1, unitPrice: 1100, lineTotal: 1100 }] }] }
  const data = { items: [{ id: 'old-product', quantity: 20 }], movements: [{ id: 'move-1' }], sales: [sale], cashClosures: [{ id: 'close-1' }] }
  const catalog = { source: { sheet: 'ProductosPrecios' }, products: [{ name: 'PIE LIMON ENTERO', price: 13000, sku: 'PP-034', category: 'Cakes', unit: 'pieces' }] }
  const result = replaceLocalCatalog(data, validateCatalog(catalog))
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].name, 'PIE LIMON ENTERO')
  assert.equal(result.items[0].price, 13000)
  assert.equal(result.items[0].quantity, 0)
  assert.equal(result.items[0].sellable, true)
  assert.equal(result.movements.length, 0)
  const detached = structuredClone(sale)
  detached.items[0].itemId = null
  detached.refunds[0].items[0].itemId = null
  assert.deepEqual(result.sales, [detached])
  assert.deepEqual(result.cashClosures, data.cashClosures)
  assert.equal(data.sales[0].items[0].itemId, 'old-product')
  assert.equal(data.items[0].quantity, 20)
})

test('catalog import rejects invalid prices and duplicate products before mutation', () => {
  const catalog = { source: { sheet: 'ProductosPrecios' }, products: [{ name: 'A', price: 0, sku: 'A' }] }
  assert.throws(() => validateCatalog(catalog))
  catalog.products = [{ name: 'A', price: 1000, sku: 'A' }, { name: 'A', price: 2000, sku: 'B' }]
  assert.throws(() => validateCatalog(catalog))
})
