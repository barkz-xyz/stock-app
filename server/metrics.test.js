import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { businessDateAt } from './cash-closure.js'

test('sales metrics and the daily cash close reconcile payment methods', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bakery-metrics-test-'))
  process.env.DATA_PATH = path.join(temporaryDirectory, 'inventory.json')
  process.env.SEED_DEMO_DATA = 'false'
  const store = await import(`./store.js?metrics-test=${Date.now()}`)

  try {
    await store.initializeStore()
    const product = await store.createItem({
      name: 'Metric croissant', category: 'Pastries', unit: 'pieces', quantity: 20,
      lowStockThreshold: 2, sku: 'METRIC-1', expiryDate: null, price: 1500, sellable: true,
    })

    const cashSale = await store.createSale([{ itemId: product.id, quantity: 2 }], 'cash')
    const cardSale = await store.createSale([{ itemId: product.id, quantity: 3 }], 'card')
    const pointOrder = {
      id: `POINT-${cardSale.id}`, status: 'processed', status_detail: 'accredited',
      external_reference: `sale-${cardSale.id}`,
      transactions: { payments: [{ id: `PAY-${cardSale.id}`, status: 'processed', status_detail: 'accredited' }] },
    }
    await store.attachPointOrder(cardSale.id, pointOrder)
    await store.updateSaleFromPoint(pointOrder)
    const cashRefund = await store.prepareRefund(cashSale.id, {
      amount: 1500,
      items: [{ lineId: cashSale.items[0].lineId, quantity: 1 }], reason: 'Returned item', restock: true,
      creditNoteRequired: false, originalDocumentType: '', originalFolio: '',
    })
    await store.completeRefund(cashRefund.refund.id)

    const now = new Date()
    const from = new Date(now.getTime() - 86400000)
    const to = new Date(now.getTime() + 86400000)
    const previousTo = new Date(from)
    const previousFrom = new Date(previousTo.getTime() - (to.getTime() - from.getTime()))
    const businessDate = businessDateAt(now)
    const period = { from, to, previousFrom, previousTo, todayFrom: from, todayTo: to, businessDate }

    const metrics = await store.getSalesMetrics(period)
    assert.equal(metrics.summary.revenue, 6000)
    assert.equal(metrics.summary.refundedTotal, 1500)
    assert.equal(metrics.summary.transactions, 2)
    assert.equal(metrics.summary.itemsSold, 4)
    assert.equal(metrics.summary.averageTicket, 3000)
    assert.equal(metrics.paymentMethods.cash.revenue, 1500)
    assert.equal(metrics.paymentMethods.card.revenue, 4500)
    assert.equal(metrics.topProducts[0].quantity, 4)
    assert.equal(metrics.topProducts[0].revenue, 6000)

    const workspace = await store.getCashClosureWorkspace(businessDate)
    const closure = await store.saveCashClosure({
      businessDate, openingCash: 10000, cashIn: 0, cashOut: 1000, countedCash: 10500, countedCard: 4500,
      operator: 'Test operator', expectedRevision: 0, fingerprint: workspace.live.fingerprint, note: 'Test close',
    })
    assert.equal(closure.cashSales, 1500)
    assert.equal(closure.cardSales, 4500)
    assert.equal(closure.expectedCash, 10500)
    assert.equal(closure.difference, 0)
    assert.equal(closure.transactionCount, 2)

    const refreshed = await store.getSalesMetrics(period)
    assert.equal(refreshed.cashClosure.id, closure.id)
    assert.equal(refreshed.cashClosure.note, 'Test close')
  } finally {
    await store.closeStore()
    await fs.rm(temporaryDirectory, { recursive: true, force: true })
  }
})
