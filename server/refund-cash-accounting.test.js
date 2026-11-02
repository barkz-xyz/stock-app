import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { inflateSync } from 'node:zlib'
import pg from 'pg'
import { PDFDocument } from 'pdf-lib'
import { createCashClosurePdf } from './cash-closure-pdf.js'
import { initializeCashLedger } from './cash-ledger.js'

const id = () => crypto.randomUUID()
const pdfText = pdf => pdf.getPages().flatMap(page => page.node.Contents().asArray().map(ref => {
  const source = inflateSync(pdf.context.lookup(ref).getContents()).toString('latin1')
  return [...source.matchAll(/<([a-fA-F0-9]+)>\s*Tj/g)].map(m => Buffer.from(m[1], 'hex').toString('latin1')).join('\n')
})).join('\n')

for (const postgres of [false, true]) test(`cash refunds follow the paying register (${postgres ? 'PostgreSQL' : 'JSON'})`,
  { skip: postgres && !process.env.TEST_DATABASE_URL }, async t => {
    const previous = { DATABASE_URL: process.env.DATABASE_URL, DATA_PATH: process.env.DATA_PATH }
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bakery-refund-cash-'))
    const schema = 'verify_refund_' + id().replaceAll('-', '')
    let store, admin, db
    try {
      if (postgres) {
        const url = new URL(process.env.TEST_DATABASE_URL)
        const ssl = process.env.PGSSLMODE === 'disable' || ['localhost', '127.0.0.1', '::1'].includes(url.hostname) ? false : { rejectUnauthorized: true }
        admin = new pg.Client({ connectionString: url.href, ssl }); await admin.connect()
        await admin.query(`CREATE SCHEMA "${schema}"`)
        url.searchParams.set('options', `-c search_path=${schema}`)
        process.env.DATABASE_URL = url.href
        db = new pg.Pool({ connectionString: url.href, ssl })
      } else delete process.env.DATABASE_URL
      process.env.DATA_PATH = path.join(directory, 'data.json')
      store = await import(`./store.js?refund-cash=${id()}`)
      await store.initializeStore()
      const cash = store.getRegisterCashStore()
      const open = async (amount = 1000, role = 'cashier') => {
        const user = await store.createUser({ username: 'refund.' + id().slice(0, 8), name: 'Responsable devolución', role, password: 'Local-Fixture-2026' })
        const session = await store.openRegisterSession(user, amount)
        return { user, session, actor: { ...user, sessionId: session.id } }
      }
      const saleFor = async actor => {
        const item = await store.createItem({ name: 'Pan de prueba', category: 'Bread', unit: 'pieces', quantity: 2, price: 1000, sellable: true, lowStockThreshold: 0, sku: '', expiryDate: null })
        return store.createSale([{ itemId: item.id, quantity: 1 }], 'cash', id(), 1000, actor)
      }
      const prepare = async (sale, amount = 500) => (await store.prepareRefund(sale.id, { amount, items: [], reason: 'Prueba devolución', restock: false,
        creditNoteRequired: false, originalDocumentType: '', originalFolio: '' })).refund
      const close = async ({ user, session }, countedCash) => {
        const work = await store.getRegisterClosure(user, session.id)
        return store.saveRegisterClosure(user, session.id, { openingCash: session.openingCash, cashIn: 0, cashOut: 0, countedCash,
          note: 'Verificación local', expectedRevision: work.closure?.revision || 0, fingerprint: work.live.fingerprint })
      }

      await t.test('same-session refund debits once, preserves sales revenue and produces a consistent PDF', async () => {
        const payer = await open(100), sale = await saleFor(payer.actor), refund = await prepare(sale, 400)
        const result = await store.completeRefund(refund.id, null, payer.actor)
        assert.equal(result.refundedTotal, 400)
        assert.equal(result.refunds[0].cashRegisterSessionId, payer.session.id)
        assert.equal(result.refunds[0].processedBy, payer.user.id)
        const work = await cash.workspace(payer.user)
        assert.equal(work.balance, 700); assert.equal(work.entries.length, 1)
        assert.deepEqual([work.entries[0].kind, work.entries[0].saleId, work.entries[0].refundId, work.entries[0].createdBy], ['refund', sale.id, refund.id, payer.user.id])
        const closed = await close(payer, 700)
        assert.equal(closed.snapshot.cash.gross, 1000); assert.equal(closed.snapshot.cash.refunds, 400)
        assert.equal(closed.snapshot.cash.net, 600); assert.equal(closed.snapshot.cashLedger.net, 0)
        assert.equal(closed.expectedCash, 700); assert.equal(closed.difference, 0)
        const text = pdfText(await PDFDocument.load(await createCashClosurePdf(closed)))
        assert.match(text, /MOVIMIENTOS \(2\)/); assert.doesNotMatch(text, /RETIROS Y RENDICIONES/)
      })

      await t.test('a closed shift refund debits the current drawer and preserves the original close', async () => {
        const first = await open(0), sale = await saleFor(first.actor)
        await close(first, 1000)
        const original = await store.getRegisterClosureRevision(first.user, first.session.id, 1)
        const next = await store.openRegisterSession(first.user, { ...(await store.getRegisterOpening(first.user)), additionalCash: 0 })
        const refund = await prepare(sale)
        await store.completeRefund(refund.id, null, { ...first.user, sessionId: next.id })
        assert.equal((await cash.workspace(first.user)).balance, 500)
        const current = await store.getRegisterClosure(first.user, next.id)
        assert.equal(current.live.cash.gross, 0); assert.equal(current.live.cash.refunds, 500); assert.equal(current.live.cash.net, -500)
        assert.deepEqual(await store.getRegisterClosureRevision(first.user, first.session.id, 1), original)
        assert.deepEqual((await store.getRegisterClosure(first.user, first.session.id)).live, original.snapshot)
        const closed = await close({ user: first.user, session: next }, 500)
        assert.equal(closed.expectedCash, 500); assert.equal(closed.difference, 0)
        assert.equal((await store.getSale(sale.id)).refundableTotal, 500)
        const daily = await store.getDailySummary()
        assert.ok(daily.refundedTotal >= 500)
      })

      await t.test('an authorized admin pays another cashier sale from their own drawer', async () => {
        const original = await open(0), sale = await saleFor(original.actor), payer = await open(1000, 'admin')
        const refund = await prepare(sale)
        await store.completeRefund(refund.id, null, payer.actor)
        assert.equal((await cash.workspace(original.user)).balance, 1000)
        assert.equal((await store.getRegisterClosure(original.user, original.session.id)).live.cash.refunds, 0)
        assert.equal((await cash.workspace(payer.user)).balance, 500)
        const live = (await store.getRegisterClosure(payer.user, payer.session.id)).live
        assert.equal(live.cash.gross, 0); assert.equal(live.cash.refunds, 500)
        assert.equal(live.operations[0].saleId, sale.id); assert.equal(live.operations[0].processedBy, payer.user.id)
      })

      await t.test('pending refunds require the actor own open session, even for an old sale', async () => {
        const original = await open(0), sale = await saleFor(original.actor)
        await close(original, 1000)
        const refund = await prepare(sale)
        const other = await open()
        for (const actor of [null, original.actor, { ...original.user, sessionId: other.session.id }, { ...original.user }]) {
          await assert.rejects(store.completeRefund(refund.id, null, actor), { code: 'SESSION_REQUIRED' })
        }
        const unchanged = await store.getSale(sale.id)
        assert.equal(unchanged.refunds[0].status, 'pending'); assert.equal(unchanged.refundedTotal, 0)
        assert.equal((await cash.workspace(other.user)).entries.length, 0)
      })

      await t.test('insufficient paying drawer cash does not change the refund or issue a payout', async () => {
        const original = await open(0), sale = await saleFor(original.actor), payer = await open(400, 'admin'), refund = await prepare(sale)
        await assert.rejects(store.completeRefund(refund.id, null, payer.actor), { code: 'INSUFFICIENT_CASH' })
        assert.equal((await cash.workspace(payer.user)).balance, 400)
        assert.equal((await cash.workspace(payer.user)).entries.length, 0)
        assert.equal((await store.getSale(sale.id)).refunds[0].status, 'pending')
      })

      await t.test('concurrent completion and later retries pay exactly once, including after close', async () => {
        const original = await open(0), sale = await saleFor(original.actor), payer = await open(1000, 'admin'), refund = await prepare(sale, 1000)
        const results = await Promise.all(Array.from({ length: 5 }, () => store.completeRefund(refund.id, null, payer.actor)))
        assert.ok(results.every(s => s.refundedTotal === 1000))
        assert.equal((await cash.workspace(payer.user)).balance, 0)
        assert.equal((await cash.workspace(payer.user)).entries.length, 1)
        await close(payer, 0)
        assert.equal((await store.completeRefund(refund.id)).refundedTotal, 1000)
        if (postgres) {
          assert.equal((await db.query('SELECT count(*)::int AS n FROM register_cash_entries WHERE refund_id=$1', [refund.id])).rows[0].n, 1)
          await assert.rejects(db.query('UPDATE register_cash_entries SET amount=1 WHERE refund_id=$1', [refund.id]), /immutable/)
          await assert.rejects(db.query('DELETE FROM register_cash_entries WHERE refund_id=$1', [refund.id]), /immutable/)
          await initializeCashLedger(db)
          assert.equal((await store.getSale(sale.id)).refunds[0].cashRegisterSessionId, payer.session.id)
        }
      })

      await t.test('a cross-user refund and concurrent withdrawal cannot spend the same drawer cash', async () => {
        const original = await open(0), sale = await saleFor(original.actor), payer = await open(1000, 'admin'), refund = await prepare(sale, 1000)
        const results = await Promise.allSettled([
          store.completeRefund(refund.id, null, payer.actor),
          cash.issue(payer.user, id(), { sessionId: payer.session.id, amount: 900, recipient: 'Proveedor', purpose: 'Compra local' }),
        ])
        assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
        assert.equal(results.find(r => r.status === 'rejected').reason.code, 'INSUFFICIENT_CASH')
        assert.ok([0, 100].includes((await cash.workspace(payer.user)).balance))
        assert.equal((await cash.workspace(original.user)).balance, 1000)
      })

      await t.test('an uncertain provider reference stays pending and cannot replace another saved reference', async () => {
        const payer = await open(0), sale = await saleFor(payer.actor), refund = await prepare(sale)
        const reference = 'LOCAL-REFUND-' + id()
        const first = await store.rememberPendingRefund(refund.id, { pointRefundId: reference, pointStatus: 'processing' })
        assert.equal(first.refunds[0].status, 'pending'); assert.equal(first.refunds[0].mpRefundId, reference)
        const conflict = await store.rememberPendingRefund(refund.id, { pointRefundId: 'OTHER-' + id(), pointStatus: 'processed' })
        assert.equal(conflict.refunds[0].mpRefundId, reference); assert.equal(conflict.refunds[0].mpStatus, 'processing')
        assert.equal((await cash.workspace(payer.user)).entries.length, 0)
        await store.failRefund(refund.id, 'Definitively rejected fixture')
        const failed = await store.rememberPendingRefund(refund.id, { pointRefundId: reference, pointStatus: 'processed' })
        assert.equal(failed.refunds[0].status, 'failed'); assert.equal(failed.refunds[0].mpStatus, 'processing')
      })

      if (postgres) await t.test('a payout insert failure atomically rolls back the refund and inventory', async () => {
        const payer = await open(0), sale = await saleFor(payer.actor)
        const refund = (await store.prepareRefund(sale.id, { amount: 1000, items: [{ lineId: sale.items[0].lineId, quantity: 1 }], reason: 'Retorno', restock: true, creditNoteRequired: false, originalDocumentType: '', originalFolio: '' })).refund
        await db.query(`CREATE FUNCTION reject_refund_payout() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.kind='refund' THEN RAISE EXCEPTION 'simulated refund payout failure'; END IF; RETURN NEW; END $$;
          CREATE TRIGGER test_refund_payout BEFORE INSERT ON register_cash_entries FOR EACH ROW EXECUTE FUNCTION reject_refund_payout()`)
        try { await assert.rejects(store.completeRefund(refund.id, null, payer.actor), /simulated refund payout failure/) }
        finally { await db.query('DROP TRIGGER test_refund_payout ON register_cash_entries') }
        assert.equal((await store.getSale(sale.id)).refunds[0].status, 'pending')
        assert.equal((await store.listItems()).find(i => i.id === sale.items[0].itemId).quantity, 1)
        assert.equal((await cash.workspace(payer.user)).balance, 1000)
        await store.completeRefund(refund.id, null, payer.actor)
        assert.equal((await store.listItems()).find(i => i.id === sale.items[0].itemId).quantity, 2)
      })
    } finally {
      await store?.closeStore(); await db?.end()
      if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end() }
      for (const [name, value] of Object.entries(previous)) value === undefined ? delete process.env[name] : process.env[name] = value
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
