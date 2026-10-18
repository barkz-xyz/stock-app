import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PDFDocument } from 'pdf-lib'
import { businessDateAt, closurePeriod, buildClosureSummary, cleanClosureInput, createClosure } from './cash-closure.js'
import { createCashClosurePdf } from './cash-closure-pdf.js'

const sale = (method, total, at, refunds = [], extra = {}) => ({ id: crypto.randomUUID(), shortId: 'ABC12345',
  status: 'paid', paymentMethod: method, total, createdAt: at, paidAt: at, refunds,
  items: [{ name: 'Croissant de mantequilla', quantity: 1, unitPrice: total, lineTotal: total }],
  mpFeeAmount: 0, mpNetReceivedAmount: null, ...extra })
const refund = (amount, at) => ({ id: crypto.randomUUID(), status: 'processed', amount, processedAt: at, createdAt: at,
  reason: 'Devolución de producto', items: [{ name: 'Producto devuelto', quantity: 1, unitPrice: amount, lineTotal: amount }] })
const draft = live => ({ businessDate: live.businessDate, openingCash: 10000, cashIn: 500, cashOut: 200,
  countedCash: 10000 + live.cash.net + 300, countedCard: live.card.net, operator: 'Operador de prueba',
  note: 'Entrada y retiro de efectivo documentados.', expectedRevision: 0, fingerprint: live.fingerprint })

test('cash close follows Chile calendar boundaries, DST, old refunds and terminal reconciliation', () => {
  const period = closurePeriod('2026-10-17')
  assert.equal(period.from.toISOString(), '2026-10-17T03:00:00.000Z')
  assert.equal(period.to.toISOString(), '2026-10-18T03:00:00.000Z')
  const dst = closurePeriod('2026-09-06')
  assert.equal((dst.to - dst.from) / 3600000, 23)
  const sales = [sale('cash', 3000, '2026-10-17T12:00:00Z', [refund(1000, '2026-10-17T13:00:00Z')]),
    sale('cash', 5000, '2026-10-16T12:00:00Z', [refund(4000, '2026-10-18T02:59:59Z')]),
    sale('card', 7000, '2026-10-17T14:00:00Z', [], { mpFeeAmount: 200, mpNetReceivedAmount: 6800 }),
    sale('card', 1000, '2026-10-17T15:00:00Z'),
    sale('card', 9000, '2026-10-16T12:00:00Z', [refund(2000, '2026-10-17T16:00:00Z')]),
    sale('card', 500, '2026-10-17T19:00:00Z', [], { status: 'pending' }),
    sale('cash', 999, '2026-10-18T03:00:00Z')]
  const summary = buildClosureSummary(sales, period)
  assert.equal(summary.cash.gross, 3000)
  assert.equal(summary.cash.refunds, 5000)
  assert.equal(summary.cash.net, -2000)
  assert.equal(summary.card.net, 6000)
  assert.equal(summary.card.recordedFees, 200)
  assert.equal(summary.card.recordedSettlement, 6800)
  assert.equal(summary.card.unreconciledTransactions, 1)
  assert.equal(summary.pendingCount, 1)
  assert.equal(summary.net, 4000)
  assert.equal(summary.operations.length, 6)
  const closure = createClosure(summary, cleanClosureInput({ ...draft(summary), countedCard: 5900 }), null)
  assert.equal(closure.expectedCash, 8300)
  assert.equal(closure.difference, 0)
  assert.equal(closure.cardDifference, -100)
  for (const date of ['2026-02-30', 'invalid', '2100-01-01', null]) assert.throws(() => closurePeriod(date), { status: 400 })
})

test('cash close validates actual declarations, denomination counts and explanations', () => {
  const summary = buildClosureSummary([], closurePeriod('2026-10-17'))
  const base = { ...draft(summary), cashIn: 0, cashOut: 0, countedCash: 10000, note: '' }
  for (const body of [null, undefined, [], 123]) assert.throws(() => cleanClosureInput(body), { status: 400 })
  for (const patch of [{ countedCash: '' }, { countedCard: null }, { openingCash: -1 }, { cashIn: 1.5 }, { countedCash: true }, { operator: '' }, { countedCard: 1e15 }, { expectedRevision: -1 }]) {
    assert.throws(() => cleanClosureInput({ ...base, ...patch }))
  }
  const cash = cleanClosureInput({ ...base, denominations: { 10000: 1 } })
  assert.equal(createClosure(summary, cash, null).difference, 0)
  assert.throws(() => cleanClosureInput({ ...base, denominations: { 10000: 2 } }), /desglose/)
  assert.throws(() => createClosure(summary, cleanClosureInput({ ...base, countedCard: 50 }), null), /observación/)
  assert.throws(() => createClosure(summary, cleanClosureInput({ ...base, cashOut: 50 }), null), /observación/)
})

test('file closures preserve snapshots and revisions, reject racing writes and detect later changes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bakery-close-'))
  process.env.DATA_PATH = path.join(directory, 'inventory.json')
  process.env.SEED_DEMO_DATA = 'false'
  delete process.env.DATABASE_URL
  const store = await import(`./store.js?closure=${crypto.randomUUID()}`)
  try {
    await store.initializeStore()
    const sales = [sale('cash', 1000, '2026-10-16T12:00:00Z', [refund(1000, '2026-10-17T13:00:00Z')])]
    await fs.writeFile(process.env.DATA_PATH, JSON.stringify({ items: [], movements: [], cashClosures: [], sales }))
    let work = await store.getCashClosureWorkspace('2026-10-17')
    assert.equal(work.live.cash.net, -1000)
    const input = draft(work.live)
    const results = await Promise.allSettled([store.saveCashClosure(input), store.saveCashClosure(input)])
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'CLOSURE_CHANGED')
    const first = await store.getCashClosureRevision(input.businessDate, 1)
    assert.equal(first.totalSales, -1000)
    let raw = JSON.parse(await fs.readFile(process.env.DATA_PATH, 'utf8'))
    raw.sales.push(sale('card', 2500, '2026-10-17T14:00:00Z'))
    await fs.writeFile(process.env.DATA_PATH, JSON.stringify(raw))
    work = await store.getCashClosureWorkspace(input.businessDate)
    assert.equal(work.stale, true)
    await assert.rejects(store.saveCashClosure({ ...input, expectedRevision: 1 }), { code: 'CLOSURE_CHANGED' })
    const second = await store.saveCashClosure({ ...draft(work.live), expectedRevision: 1, note: 'Corrección: incluir cobro posterior.' })
    assert.equal(second.revision, 2)
    assert.equal(second.cardSales, 2500)
    assert.deepEqual(await store.getCashClosureRevision(input.businessDate, 1), first)
    work = await store.getCashClosureWorkspace(input.businessDate)
    assert.equal(work.stale, false)
    assert.equal(work.revisions.length, 2)
    assert.equal(work.closure.history, undefined)
    assert.equal((await store.getCashClosureRevision(input.businessDate, 2)).id, first.id)
    await assert.rejects(store.getCashClosureRevision('2026-10-16'), { status: 404 })
    raw = JSON.parse(await fs.readFile(process.env.DATA_PATH, 'utf8'))
    assert.equal(raw.sales.length, 2)
    assert.equal(raw.sales[0].refunds.length, 1)
  } finally { await store.closeStore(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('detailed cash close PDF is paginated, compressed and bounded for a busy day', async () => {
  const period = closurePeriod('2026-10-17')
  const sales = Array.from({ length: 150 }, (_, i) => sale(i % 2 ? 'cash' : 'card', 1500, '2026-10-17T12:00:00Z', [],
    { items: [{ name: `Empanada champiñón / queso ${'x'.repeat(150)}`, quantity: 1, unitPrice: 1500, lineTotal: 1500 }] }))
  const summary = buildClosureSummary(sales, period)
  const closure = createClosure(summary, cleanClosureInput(draft(summary)), null)
  const bytes = await createCashClosurePdf(closure)
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-')
  assert.match(bytes.toString('latin1'), /FlateDecode/)
  assert.match(bytes.toString('latin1'), /ObjStm/)
  assert.ok(bytes.length < 150000, `${bytes.length} bytes`)
  const pdf = await PDFDocument.load(bytes)
  assert.ok(pdf.getPageCount() > 10)
  assert.match(pdf.getTitle(), /2026-10-17/)
  assert.equal(pdf.getAuthor(), 'Bakery POS')
})
