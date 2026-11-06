import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import pg from 'pg'
import { businessDayKey, registerIsActive, scheduleRegisterDay } from '../src/registerDay.js'
import { closurePeriod } from './cash-closure.js'
import { postgresConfig } from './postgres.js'
import { migrateDatabase } from './schema.js'

test('register day follows Chile midnight and the rollover timer uses the server clock', () => {
  const before = '2026-11-01T02:59:59.000Z', after = '2026-11-01T03:00:00.000Z'
  assert.equal(businessDayKey(before), '2026-10-31'); assert.equal(businessDayKey(after), '2026-11-01')
  const session = { openedAt: before, businessDate: '2026-10-31', closedAt: null }
  assert.equal(registerIsActive(session, businessDayKey(before)), true)
  assert.equal(registerIsActive(session, businessDayKey(after)), false)
  assert.equal(registerIsActive({ ...session, closedAt: before }, businessDayKey(before)), false)
  let delay, callback, removed, calls = 0
  const timers = { setTimeout(fn, ms) { callback = fn; delay = ms; return 42 }, clearTimeout(id) { removed = id } }
  const cancel = scheduleRegisterDay({ nextDayAt: after, serverNow: before }, () => { calls++ }, timers)
  assert.equal(delay, 1025); callback(); assert.equal(calls, 1); cancel(); assert.equal(removed, 42)
  for (const day of ['2026-09-05', '2026-04-04']) {
    const period = closurePeriod(day)
    assert.equal(businessDayKey(period.to), businessDayKey(new Date(period.to.getTime() + 1)))
    assert.notEqual(businessDayKey(new Date(period.to.getTime() - 1)), businessDayKey(period.to))
  }
})

for (const postgres of [false, true]) test(`a new day skips an unclosed register and keeps sales and cash assigned correctly (${postgres ? 'PostgreSQL' : 'JSON'})`,
  { skip: postgres && !process.env.TEST_DATABASE_URL, timeout: 30000 }, async t => {
    const previous = { DATABASE_URL: process.env.DATABASE_URL, DATA_PATH: process.env.DATA_PATH, SEED_DEMO_DATA: process.env.SEED_DEMO_DATA }
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bakery-register-day-'))
    const schema = 'verify_register_day_' + crypto.randomUUID().replaceAll('-', '')
    let admin, store, isolatedUrl
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-01T02:59:59.000Z') })
    try {
      if (postgres) {
        admin = new pg.Client(postgresConfig(process.env.TEST_DATABASE_URL)); await admin.connect()
        await admin.query(`CREATE SCHEMA "${schema}"`); await admin.query(`SET search_path TO "${schema}"`)
        const url = new URL(process.env.TEST_DATABASE_URL); url.searchParams.set('options', `-c search_path=${schema}`)
        isolatedUrl = url.href; process.env.DATABASE_URL = isolatedUrl
      } else delete process.env.DATABASE_URL
      process.env.DATA_PATH = path.join(temp, 'data.json'); process.env.SEED_DEMO_DATA = 'false'
      store = await import(`./store.js?register-day=${crypto.randomUUID()}`); await store.initializeStore()
      const user = await store.createUser({ username: 'daily.operator', name: 'Daily operator', role: 'admin', password: 'Local-Daily-2026' })
      const first = await store.openRegisterSession(user, { openingCash: 2000, businessDate: '2026-10-31' })
      assert.equal(first.businessDate, '2026-10-31')
      const firstActor = { ...user, sessionId: first.id }
      const item = await store.createItem({ name: 'Daily bread', category: 'Bread', unit: 'pieces', quantity: 10, price: 1000, sellable: true, lowStockThreshold: 0, sku: '', expiryDate: null })
      const cart = [{ itemId: item.id, quantity: 1 }], saleKey = crypto.randomUUID(), withdrawalKey = crypto.randomUUID()
      const cashSale = await store.createSale(cart, 'cash', saleKey, 1000, firstActor)
      const pendingCard = await store.createSale(cart, 'card', crypto.randomUUID(), null, firstActor)
      const cash = store.getRegisterCashStore()
      const withdrawalBody = { sessionId: first.id, amount: 100, recipient: 'Purchases', purpose: 'Day one' }
      const withdrawal = (await cash.issue(user, withdrawalKey, withdrawalBody)).withdrawal
      assert.equal((await cash.workspace(user)).balance, 2900)
      if (postgres) await t.test('migration backfills an old open register without closing or replacing it', async () => {
        await admin.query('ALTER TABLE register_sessions DROP COLUMN business_date CASCADE')
        await admin.query('CREATE UNIQUE INDEX one_open_register_per_user ON register_sessions(user_id) WHERE closed_at IS NULL')
        const migrationPool = new pg.Pool(postgresConfig(isolatedUrl))
        try { await migrateDatabase(migrationPool) } finally { await migrationPool.end() }
        const preserved = (await admin.query('SELECT * FROM register_sessions WHERE id=$1', [first.id])).rows[0]
        assert.equal(businessDayKey(preserved.opened_at), '2026-10-31'); assert.equal(preserved.closed_at, null)
        assert.equal((await store.getActiveRegisterSession(user)).id, first.id)
      })

      t.mock.timers.tick(1000)
      assert.equal(businessDayKey(), '2026-11-01')
      assert.equal(await store.getActiveRegisterSession(user), null)
      assert.equal((await cash.workspace(user)).session, null)
      assert.equal((await cash.workspace(user)).balance, 0)
      assert.equal((await store.getRegisterClosure(user, first.id)).session.closedAt, null)
      await assert.rejects(store.createSale(cart, 'cash', crypto.randomUUID(), 1000, firstActor), { code: 'SESSION_REQUIRED' })
      await assert.rejects(cash.issue(user, crypto.randomUUID(), withdrawalBody), { code: 'SESSION_REQUIRED' })
      const settlement = { sessionId: first.id, spentAmount: 60, documentType: 'boleta', documentNumber: 'TEST-1', supplier: 'Test supplier', detail: 'Day one expense' }
      await assert.rejects(cash.settle(user, withdrawal.id, crypto.randomUUID(), settlement), { code: 'SESSION_REQUIRED' })
      assert.equal((await store.createSale(cart, 'cash', saleKey, 1000, firstActor)).id, cashSale.id)
      assert.equal((await cash.issue(user, withdrawalKey, withdrawalBody)).replayed, true)
      assert.equal((await store.listItems())[0].quantity, 8)
      await assert.rejects(store.openRegisterSession(user, { openingCash: 1600, businessDate: '2026-10-31' }), { code: 'OPENING_CHANGED' })
      const context = await store.getRegisterOpening(user)
      const opened = await Promise.all(Array.from({ length: 6 }, () => store.openRegisterSession(user, { ...context, openingCash: 1500, additionalCash: 100 })))
      assert.equal(new Set(opened.map(s => s.id)).size, 1)
      const second = opened[0], secondActor = { ...user, sessionId: second.id }
      assert.notEqual(second.id, first.id); assert.equal(second.businessDate, '2026-11-01'); assert.equal(second.openingCash, 1600)
      assert.equal((await store.getActiveRegisterSession(user)).id, second.id)
      const october = await store.listClosureHistory(user, { month: '2026-10' })
      assert.equal(october.entries[0].id, first.id); assert.equal(october.entries[0].status, 'open'); assert.equal(october.entries[0].countedCash, null)
      const today = await store.createSale(cart, 'cash', crypto.randomUUID(), 1000, secondActor)
      assert.equal(today.registerSessionId, second.id)
      assert.equal((await cash.workspace(user)).balance, 2600)
      await cash.settle(user, withdrawal.id, crypto.randomUUID(), { ...settlement, sessionId: second.id })
      assert.equal((await cash.workspace(user)).balance, 2640)
      const prepared = await store.prepareRefund(cashSale.id, { amount: 200, items: [], restock: false, reason: 'Daily test', creditNoteRequired: false, originalDocumentType: '', originalFolio: '' })
      await assert.rejects(store.completeRefund(prepared.refund.id, null, firstActor), { code: 'SESSION_REQUIRED' })
      await store.completeRefund(prepared.refund.id, null, secondActor)
      assert.equal((await cash.workspace(user)).balance, 2440)
      await store.completeRefund(prepared.refund.id, null, firstActor)
      assert.equal((await cash.workspace(user)).balance, 2440, 'A recovery using the old register cannot pay a processed refund twice')
      assert.equal((await store.getRegisterClosure(user, first.id)).live.cash.refunds, 0)
      // Approval received on day two still belongs to the original day-one order.
      const order = { id: `LOCAL-${pendingCard.id}`, external_reference: pendingCard.mpExternalReference, status: 'processed', status_detail: 'accredited',
        transactions: { payments: [{ id: 'LOCAL-PAY', status: 'processed', status_detail: 'accredited' }] } }
      await store.attachPointOrder(pendingCard.id, order)
      await store.updateSaleFromPoint(order)
      assert.equal((await store.getSale(pendingCard.id)).registerSessionId, first.id)
      assert.equal((await store.getRegisterClosure(user, second.id)).live.card.net, 0)
      const close = async (session, countedCash) => {
        const work = await store.getRegisterClosure(user, session.id)
        return store.saveRegisterClosure(user, session.id, { countedCash, cashIn: 0, cashOut: 0, note: 'Daily verification', expectedRevision: 0, fingerprint: work.live.fingerprint })
      }
      await close(second, 2440)
      await close(first, 2900)
      assert.equal((await store.getRegisterOpening(user)).previousSessionId, second.id, 'A late old close must not replace the more recent business day opening reference')
      assert.equal(await store.getActiveRegisterSession(user), null)
      t.mock.timers.tick(86400000)
      const third = await store.openRegisterSession(user, await store.getRegisterOpening(user))
      assert.equal(third.businessDate, '2026-11-02'); assert.equal(third.openingCash, 2440)
      assert.equal((await store.getRegisterClosureRevision(user, first.id, 1)).cashSales, 1000)
    } finally {
      await store?.closeStore()
      if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end() }
      for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
      await fs.rm(temp, { recursive: true, force: true })
      t.mock.timers.reset()
    }
  })
