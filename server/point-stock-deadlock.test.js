import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { once } from 'node:events'
import test from 'node:test'
import express from 'express'
import pg from 'pg'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readInventorySnapshot } from './inventory-snapshot.js'
import { deploymentTestEnvironment } from '../scripts/test-deploy.js'

test('PostgreSQL Point restorations lock all products before the inventory revision', { skip: !process.env.TEST_DATABASE_URL, timeout: 300000 }, async t => {
  const schema = `verify_point_locks_${crypto.randomUUID().replaceAll('-', '')}`
  const connectionString = process.env.TEST_DATABASE_URL
  const ssl = !connectionString.includes('railway.internal') && process.env.PGSSLMODE !== 'disable' ? { rejectUnauthorized: false } : false
  const admin = new pg.Client({ connectionString, ssl })
  const previousUrl = process.env.DATABASE_URL
  let store, monitor, controller, server
  const operations = new Map()
  try {
    await admin.connect()
    await admin.query(`CREATE SCHEMA "${schema}"`)
    const isolated = new URL(connectionString)
    isolated.searchParams.set('options', `-c search_path=${schema} -c statement_timeout=10000`)
    isolated.searchParams.set('application_name', schema)
    process.env.DATABASE_URL = isolated.href
    store = await import(`./store.js?pointLocks=${crypto.randomUUID()}`)
    await store.initializeStore()
    monitor = new pg.Client({ connectionString: isolated.href, ssl })
    controller = new pg.Client({ connectionString: isolated.href, ssl })
    await monitor.connect(); await controller.connect()
    const controllerPid = (await controller.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    const gateKey = (await controller.query('SELECT hashtextextended($1,17) AS key', [schema])).rows[0].key
    // This HTTP fixture calls the real transactional store, never a payment provider.
    const app = express()
    app.post('/:operation', async (req, res) => {
      try { res.json(await operations.get(req.params.operation)()) }
      catch (error) { res.status(error.status || 500).json({ code: error.code, message: error.message }) }
    })
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
    const request = async operation => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/${operation}`, { method: 'POST' })
      return { status: response.status, body: await response.json() }
    }
    const waitForBlocked = async blocker => {
      const deadline = Date.now() + 7000
      while (Date.now() < deadline) {
        const { rows } = await monitor.query(`SELECT pid,query FROM pg_stat_activity
          WHERE application_name=$1 AND $2=ANY(pg_blocking_pids(pid))`, [schema, blocker])
        if (rows.length) return rows[0]
      }
      throw new Error(`No operation reached the explicit PostgreSQL lock barrier (${blocker})`)
    }
    const products = async () => {
      const items = []
      for (let n = 0; n < 2; n++) items.push(await store.createItem({
        name: `Fictitious ${crypto.randomUUID()}`, category: 'Bread', unit: 'pieces', quantity: 3,
        price: 1000, sellable: true, lowStockThreshold: 0, sku: '', expiryDate: null,
      }))
      return items.sort((a, b) => a.id.localeCompare(b.id))
    }
    const assertBalances = async (items, expected) => {
      const { rows } = await monitor.query('SELECT id,quantity FROM items WHERE id=ANY($1::uuid[]) ORDER BY id', [items.map(i => i.id)])
      assert.deepEqual(rows.map(i => Number(i.quantity)), expected)
    }
    const raceRestoration = async (gateItem, restore, competing) => {
      const trigger = (await monitor.query(`SELECT tgenabled FROM pg_trigger
        WHERE tgrelid='items'::regclass AND tgname='bakery_inventory_revision'`)).rows[0]
      assert.equal(trigger?.tgenabled, 'O', 'The real revision trigger must remain active')
      // AFTER STATEMENT triggers run by name: zz_ pauses AFTER bakery_inventory_revision.
      // Transition tables distinguish a restoration from the competing decrement.
      await monitor.query(`CREATE OR REPLACE FUNCTION test_restock_gate() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF EXISTS(SELECT 1 FROM new_items n JOIN old_items o USING(id)
            WHERE n.id='${gateItem.id}'::uuid AND n.quantity>o.quantity) THEN
            PERFORM pg_advisory_xact_lock(${gateKey}::bigint);
          END IF;
          RETURN NULL;
        END $$;
        CREATE TRIGGER zz_test_restock_gate AFTER UPDATE ON items
          REFERENCING OLD TABLE AS old_items NEW TABLE AS new_items
          FOR EACH STATEMENT EXECUTE FUNCTION test_restock_gate()`)
      operations.set('restore', restore); operations.set('compete', competing)
      let restoring, competingRequest, results
      await controller.query('SELECT pg_advisory_lock($1::bigint)', [gateKey])
      try {
        restoring = request('restore')
        const writer = await waitForBlocked(controllerPid)
        await assert.rejects(monitor.query('SELECT revision FROM inventory_read_revision FOR UPDATE NOWAIT'), { code: '55P03' })
        competingRequest = request('compete')
        const waiter = await waitForBlocked(writer.pid)
        assert.notEqual(waiter.pid, writer.pid)
      } finally {
        await controller.query('SELECT pg_advisory_unlock($1::bigint)', [gateKey])
        results = await Promise.all([restoring, competingRequest].filter(Boolean))
        await monitor.query('DROP TRIGGER zz_test_restock_gate ON items')
      }
      assert.deepEqual(results.map(result => ({ status: result.status, code: result.body.code })),
        [{ status: 200, code: undefined }, { status: 200, code: undefined }])
    }

    await t.test('cancel Point A+B while Caja sells B; repeated reconciliation cannot restore twice', async () => {
      const [a, b] = await products()
      const point = await store.createSale([a, b].map(i => ({ itemId: i.id, quantity: 1 })), 'card', crypto.randomUUID())
      const order = { id: `FAKE-${crypto.randomUUID()}`, status: 'canceled' }
      await store.attachPointOrder(point.id, order)
      const before = await readInventorySnapshot(monitor)
      await raceRestoration(a, () => store.updateSaleFromPoint(order),
        () => store.createSale([{ itemId: b.id, quantity: 1 }], 'cash', crypto.randomUUID()))
      await assertBalances([a, b], [3, 2])
      const after = await readInventorySnapshot(monitor, before.revision)
      assert.notEqual(after.revision, before.revision); assert.notEqual(after.rows, null)
      const movements = await monitor.query('SELECT * FROM movements WHERE sale_id=$1 ORDER BY id', [point.id])
      assert.equal(movements.rows.filter(m => m.type === 'stock_in').length, 2)
      await Promise.all([store.updateSaleFromPoint(order), store.markCardSaleFailed(point.id, 'repeated reconciliation')])
      await assertBalances([a, b], [3, 2])
      assert.deepEqual((await monitor.query('SELECT * FROM movements WHERE sale_id=$1 ORDER BY id', [point.id])).rows, movements.rows)
      assert.equal((await readInventorySnapshot(monitor, after.revision)).rows, null)
    })

    await t.test('reverse Point input and an overlapping stock batch complete without a cycle', async () => {
      const [a, b] = await products(), [c] = await products()
      const point = await store.createSale([b, a].map(i => ({ itemId: i.id, quantity: 1 })), 'card', crypto.randomUUID())
      const batchKey = crypto.randomUUID()
      const batch = { type: 'stock_in', items: [c, b].map(i => ({ itemId: i.id, quantity: 1 })) }
      await raceRestoration(a, () => store.markCardSaleFailed(point.id, 'simulated provider rejection'),
        () => store.saveInventoryBatch(batch, batchKey))
      await assertBalances([a, b], [3, 4])
      await assertBalances([c], [4])
      assert.equal((await store.saveInventoryBatch(batch, batchKey)).replayed, true)
      await assertBalances([a, b], [3, 4])
    })

    await t.test('overlapping Point cancellations with opposite input order each restore once', async () => {
      const [a, b] = await products()
      const points = []
      for (const items of [[a, b], [b, a]]) points.push(await store.createSale(items.map(i => ({ itemId: i.id, quantity: 1 })), 'card', crypto.randomUUID()))
      await raceRestoration(a, () => store.markCardSaleFailed(points[0].id), () => store.markCardSaleFailed(points[1].id))
      await assertBalances([a, b], [3, 3])
      await Promise.all(points.map(sale => store.markCardSaleFailed(sale.id)))
      await assertBalances([a, b], [3, 3])
      assert.equal((await monitor.query("SELECT count(*)::int AS n FROM movements WHERE sale_id=ANY($1::uuid[]) AND type='stock_in'", [points.map(p => p.id)])).rows[0].n, 4)
    })

    const reverseNames = async (a, b) => {
      await store.updateItem(a.id, { ...a, name: 'Z fictitious bread' })
      await store.updateItem(b.id, { ...b, name: 'A fictitious bread' })
    }
    const prepareFullRefund = sale => store.prepareRefund(sale.id, {
      amount: sale.total, items: sale.items.map(i => ({ lineId: i.lineId, quantity: i.quantity })),
      reason: 'Fictitious return', restock: true, creditNoteRequired: false, originalDocumentType: '', originalFolio: '',
    })
    await t.test('a restocking refund uses UUID locks even when its line names have the opposite order', async () => {
      const [a, b] = await products(); await reverseNames(a, b)
      const sale = await store.createSale([b, a].map(i => ({ itemId: i.id, quantity: 1 })), 'cash', crypto.randomUUID())
      const { refund } = await prepareFullRefund(sale)
      await raceRestoration(b, () => store.completeRefund(refund.id),
        () => store.createSale([{ itemId: a.id, quantity: 1 }], 'cash', crypto.randomUUID()))
      await assertBalances([a, b], [2, 3])
      await store.completeRefund(refund.id)
      await assertBalances([a, b], [2, 3])
      assert.equal((await monitor.query("SELECT count(*)::int AS n FROM movements WHERE sale_id=$1 AND type='stock_in'", [sale.id])).rows[0].n, 2)
    })

    const terminalRefund = async (items) => {
      const sale = await store.createSale(items.map(i => ({ itemId: i.id, quantity: 1 })), 'card', crypto.randomUUID())
      const order = { id: `FAKE-${crypto.randomUUID()}`, status: 'processed', status_detail: 'accredited', transactions: {
        payments: [{ id: `FAKE-PAY-${crypto.randomUUID()}`, status_detail: 'accredited' }],
      } }
      await store.attachPointOrder(sale.id, order); await store.updateSaleFromPoint(order)
      order.transactions.refunds = [{ id: `FAKE-REF-${crypto.randomUUID()}`, status: 'processed', amount: String(sale.total) }]
      const reconciled = await store.updateSaleFromPoint(order)
      return { sale: reconciled, refund: reconciled.refunds[0] }
    }
    await t.test('Point refund inventory review prelocks its products and cannot restore twice', async () => {
      const [a, b] = await products(); await reverseNames(a, b)
      const { sale, refund } = await terminalRefund([b, a])
      await raceRestoration(b, () => store.resolveRefundInventoryReview(sale.id, refund.id, true),
        () => store.createSale([{ itemId: a.id, quantity: 1 }], 'cash', crypto.randomUUID()))
      await assertBalances([a, b], [2, 3])
      await store.resolveRefundInventoryReview(sale.id, refund.id, true)
      await assertBalances([a, b], [2, 3])
      assert.equal((await monitor.query("SELECT count(*)::int AS n FROM movements WHERE sale_id=$1 AND type='stock_in'", [sale.id])).rows[0].n, 2)
    })

    // A sale-first reconciler must be able to lock the refund while a concurrent
    // refund operation waits for that sale. A child-first implementation cycles.
    const assertSaleFirst = async (sale, refund, operation) => {
      operations.set('sale-first', operation)
      let pending
      await controller.query('BEGIN')
      try {
        await controller.query('SELECT id FROM sales WHERE id=$1 FOR UPDATE', [sale.id])
        pending = request('sale-first')
        await waitForBlocked(controllerPid)
        await controller.query('SELECT id FROM refunds WHERE id=$1 FOR UPDATE', [refund.id])
      } finally {
        await controller.query('ROLLBACK')
        if (pending) assert.equal((await pending).status, 200)
      }
    }
    await t.test('refund completion, inventory review and credit notes acquire the sale before its refund', async () => {
      const [a, b] = await products()
      const sale = await store.createSale([a, b].map(i => ({ itemId: i.id, quantity: 1 })), 'cash', crypto.randomUUID())
      const { refund } = await prepareFullRefund(sale)
      await assertSaleFirst(sale, refund, () => store.completeRefund(refund.id))
      await assertSaleFirst(sale, refund, () => store.recordCreditNote(sale.id, refund.id, {
        originalDocumentType: '39', originalFolio: 'FAKE-1', folio: 'FAKE-2', siiTrackId: '',
      }))
      const terminal = await terminalRefund([a, b])
      await assertSaleFirst(terminal.sale, terminal.refund,
        () => store.resolveRefundInventoryReview(terminal.sale.id, terminal.refund.id, true))
    })

    await t.test('a failed second restoration rolls back items, revision, movements and status; restart and lost-response replay restore once', async () => {
      const [a, b] = await products()
      const point = await store.createSale([a, b].map(i => ({ itemId: i.id, quantity: 1 })), 'card', crypto.randomUUID())
      const before = await readInventorySnapshot(monitor)
      await monitor.query(`CREATE FUNCTION test_fail_restock() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.id='${b.id}'::uuid AND NEW.quantity>OLD.quantity THEN
          RAISE EXCEPTION 'simulated second restoration failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER test_fail_restock BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION test_fail_restock()`)
      try { await assert.rejects(store.markCardSaleFailed(point.id), /simulated second restoration failure/) }
      finally { await monitor.query('DROP TRIGGER test_fail_restock ON items') }
      await assertBalances([a, b], [2, 2])
      assert.equal((await readInventorySnapshot(monitor, before.revision)).rows, null)
      assert.equal((await store.getSale(point.id)).inventoryApplied, true)
      assert.equal((await monitor.query("SELECT count(*)::int AS n FROM movements WHERE sale_id=$1 AND type='stock_in'", [point.id])).rows[0].n, 0)
      const restart = () => promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
        import {initializeStore,closeStore,markCardSaleFailed} from './server/store.js';
        await initializeStore(); await markCardSaleFailed(${JSON.stringify(point.id)}); await closeStore();
      `], { windowsHide: true, timeout: 20000, env: {
        ...deploymentTestEnvironment({ ...process.env, TEST_DATABASE_URL: isolated.href }), DATABASE_URL: isolated.href,
      } })
      await restart() // Simulate a committed response lost when the first worker exits.
      const committed = await readInventorySnapshot(monitor)
      await restart()
      await assertBalances([a, b], [3, 3])
      assert.equal((await readInventorySnapshot(monitor, committed.revision)).rows, null)
      assert.equal((await monitor.query("SELECT count(*)::int AS n FROM movements WHERE sale_id=$1 AND type='stock_in'", [point.id])).rows[0].n, 2)
    })
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    if (previousUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousUrl
    await controller?.end(); await monitor?.end(); await store?.closeStore()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end()
  }
})
