import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'
import express from 'express'
import pg from 'pg'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createInventoryRouter, inventoryRepresentation } from './inventory-api.js'
import { readInventorySnapshot } from './inventory-snapshot.js'

test('PostgreSQL snapshot revisions stay coherent across commits, rollback, replicas and process restarts', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const schema = `verify_snapshots_${crypto.randomUUID().replaceAll('-', '')}`
  const connectionString = process.env.TEST_DATABASE_URL
  const ssl = !connectionString.includes('railway.internal') && process.env.PGSSLMODE !== 'disable' ? { rejectUnauthorized: false } : false
  const admin = new pg.Client({ connectionString, ssl })
  const previousUrl = process.env.DATABASE_URL
  let store, otherPool
  const servers = []
  try {
    await admin.connect(); await admin.query(`CREATE SCHEMA "${schema}"`)
    const isolated = new URL(connectionString); isolated.searchParams.set('options', `-c search_path=${schema}`)
    process.env.DATABASE_URL = isolated.href
    store = await import(`./store.js?snapshots=${crypto.randomUUID()}`); await store.initializeStore()
    otherPool = new pg.Pool({ connectionString: isolated.href, ssl })
    const integration = store.getInventoryIntegrationStore(); await integration.initialize()
    const issued = await integration.createClient({ name: 'Snapshot tests', environment: 'test', expiresInDays: 1 })
    const item = await store.createItem({ name: 'Pan decimal', category: 'Bread', unit: 'kg', quantity: 1.25, price: 1000, sellable: true, lowStockThreshold: 0, sku: '', expiryDate: null })
    let snapshotReads = 0, fullReads = 0, fail = false, forceLimit = false
    const originalRead = integration.readInventorySnapshot
    integration.readInventorySnapshot = async (...args) => {
      snapshotReads++
      if (fail) throw new Error('private database connection error')
      const result = await originalRead(...args)
      if (result.rows !== null) fullReads++
      return result
    }
    const consume = integration.consumeLimits
    integration.consumeLimits = entries => forceLimit ? 60 : consume(entries)
    const config = { enabled: true, environment: 'test' }
    const serve = async () => {
      const app = express(); app.use('/api/integrations/v1', createInventoryRouter({ getStore: () => integration, config }))
      const server = app.listen(0, '127.0.0.1'); servers.push(server); await once(server, 'listening')
      return `http://127.0.0.1:${server.address().port}/api/integrations/v1/inventory`
    }
    const first = await serve(), second = await serve()
    const get = async (base = first, etag = '', token = issued.token) => {
      const response = await fetch(base, { headers: { Authorization: `Bearer ${token}`, ...(etag ? { 'If-None-Match': etag } : {}) } })
      assert.equal(response.headers.get('cache-control'), 'private, no-store')
      assert.match(response.headers.get('vary'), /Authorization/)
      return { status: response.status, etag: response.headers.get('etag'), body: await response.text() }
    }
    let old
    await t.test('warm 304 skips reading and encoding items; validators remain content-based', async () => {
      old = await get()
      assert.equal(old.status, 200)
      assert.deepEqual({ body: old.body, etag: old.etag }, inventoryRepresentation(await integration.readInventory()))
      assert.equal((await get(first, old.etag)).status, 304)
      assert.equal(fullReads, 1); assert.equal(snapshotReads, 2)
      assert.equal((await get(second, old.etag)).status, 304, 'A fresh process/router rebuilds before validating')
      assert.equal(fullReads, 2)
      await otherPool.query('UPDATE items SET quantity=quantity WHERE id=$1', [item.id])
      assert.equal((await get(first, old.etag)).status, 304, 'A conservative revision bump need not change the content ETag')
      assert.equal(fullReads, 3)
      const snapshot = await readInventorySnapshot(otherPool)
      let query, params
      await readInventorySnapshot({ query(sql, values) { query = sql; params = values; return otherPool.query(sql, values) } }, snapshot.revision)
      const plan = (await otherPool.query('EXPLAIN (ANALYZE, FORMAT JSON) ' + query, params)).rows[0]['QUERY PLAN'][0].Plan
      const nodes = node => [node, ...(node.Plans || []).flatMap(nodes)]
      assert.ok(nodes(plan).some(node => node['Relation Name'] === 'items'))
      assert.ok(nodes(plan).filter(node => node['Relation Name'] === 'items').every(node => node['Actual Loops'] === 0), 'PostgreSQL never executes the items scan on a revision hit')
    })

    await t.test('a transaction publishes rows and revision together; rollback keeps the previous snapshot', async () => {
      const transaction = await otherPool.connect()
      try {
        await transaction.query('BEGIN')
        await transaction.query('UPDATE items SET quantity=0.50,price=1500 WHERE id=$1', [item.id])
        assert.equal((await get(first, old.etag)).status, 304, 'An uncommitted writer is invisible to readers')
        await transaction.query('ROLLBACK')
        assert.equal((await get(first, old.etag)).status, 304)
        await transaction.query('BEGIN')
        await transaction.query('UPDATE items SET quantity=0.50,price=1500 WHERE id=$1', [item.id])
        await transaction.query('COMMIT')
        const changed = await get(first, old.etag), replica = await get(second, old.etag)
        assert.equal(changed.status, 200); assert.deepEqual(replica, changed)
        const exported = JSON.parse(changed.body).items[0]
        assert.equal(exported.stockQuantity, '0.50'); assert.equal(exported.price.amount, 1500)
        old = changed
      } finally { await transaction.query('ROLLBACK'); transaction.release() }
    })

    await t.test('all exported fields invalidate even without updated_at or NOTIFY delivery', async () => {
      // No LISTEN client is running in this test. Freshness comes from the durable row.
      await otherPool.query("UPDATE items SET name='New name',sku='NEW',category='Other',unit='litres',sellable=FALSE,expiry_date='2026-12-31' WHERE id=$1", [item.id])
      const changed = await get(first, old.etag)
      assert.equal(changed.status, 200)
      const exported = JSON.parse(changed.body).items[0]
      assert.equal(exported.name, 'New name'); assert.equal(exported.sku, 'NEW'); assert.equal(exported.category, 'Other')
      assert.equal(exported.unit, 'litres'); assert.equal(exported.sellable, false); assert.equal(exported.expiryDate, '2026-12-31')
      old = changed
      const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
        import pg from 'pg'; import {readInventorySnapshot} from './server/inventory-snapshot.js';
        import {inventoryRepresentation} from './server/inventory-api.js';
        const pool=new pg.Pool({connectionString:process.env.SNAPSHOT_TEST_URL,ssl:${JSON.stringify(ssl)}});
        console.log(JSON.stringify(inventoryRepresentation((await readInventorySnapshot(pool)).rows))); await pool.end();
      `], { env: { ...process.env, SNAPSHOT_TEST_URL: isolated.href }, windowsHide: true, timeout: 15000 })
      assert.deepEqual(JSON.parse(child.stdout), { body: old.body, etag: old.etag })
    })

    await t.test('revocation, permissions, expiry and quotas take precedence over cached 304', async () => {
      // Keep these tests independent of the burst window used above.
      integration.consumeLimits = async () => forceLimit ? 60 : 0
      const reads = snapshotReads
      forceLimit = true; assert.equal((await get(first, old.etag)).status, 429); forceLimit = false
      await otherPool.query("UPDATE integration_clients SET scopes='{}' WHERE id=$1", [issued.client.id])
      assert.equal((await get(first, old.etag)).status, 403)
      await otherPool.query("UPDATE integration_clients SET scopes=ARRAY['inventory:read'] WHERE id=$1", [issued.client.id])
      await otherPool.query("UPDATE integration_keys SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [issued.key.id])
      assert.equal((await get(first, old.etag)).status, 401)
      await otherPool.query("UPDATE integration_keys SET expires_at=NOW()+INTERVAL '1 day' WHERE id=$1", [issued.key.id])
      await integration.revokeKey(issued.client.id, issued.key.id, 'test')
      assert.equal((await get(first, old.etag)).status, 401)
      assert.equal(snapshotReads, reads, 'Denied requests cannot consult or serve a cached representation')
      const replacement = await integration.rotateKey(issued.client.id, 'test', 1)
      issued.token = replacement.token
      fail = true
      const unavailable = await get(first, old.etag)
      assert.equal(unavailable.status, 503); assert.doesNotMatch(unavailable.body, /private database/)
      fail = false
    })

    await t.test('out-of-order cold responses cannot acknowledge stale inventory after a concurrent commit', async () => {
      const cold = await serve()
      const reader = integration.readInventorySnapshot
      let reached, resume, delayNext = true
      const started = new Promise(resolve => { reached = resolve })
      const paused = new Promise(resolve => { resume = resolve })
      integration.readInventorySnapshot = async (...args) => {
        const result = await reader(...args)
        if (delayNext) { delayNext = false; reached(); await paused }
        return result
      }
      try {
        const slow = get(cold)
        await started
        await otherPool.query('UPDATE items SET quantity=0.25 WHERE id=$1', [item.id])
        const current = await get(cold)
        assert.equal(JSON.parse(current.body).items[0].stockQuantity, '0.25')
        resume()
        const earlier = await slow
        assert.equal(JSON.parse(earlier.body).items[0].stockQuantity, '0.50')
        assert.notEqual(earlier.etag, current.etag)
        assert.equal((await get(cold, current.etag)).status, 304)
        assert.equal(JSON.parse((await get(cold, earlier.etag)).body).items[0].stockQuantity, '0.25')
        old = current
      } finally { resume(); integration.readInventorySnapshot = reader }
    })

    await t.test('delete, insertion and truncate cannot resurrect cached rows', async () => {
      const single = first + '/' + item.id
      const before = await get(single)
      await otherPool.query('DELETE FROM items WHERE id=$1', [item.id])
      assert.equal((await get(single, before.etag)).status, 404)
      const empty = await get(first, old.etag)
      assert.equal(JSON.parse(empty.body).count, 0)
      await store.createItem({ name: 'New product', category: 'Bread', unit: 'kg', quantity: 0.25, price: 1200, sellable: true, lowStockThreshold: 0, sku: '', expiryDate: null })
      const inserted = await get(first, empty.etag)
      assert.equal(inserted.status, 200); assert.equal(JSON.parse(inserted.body).count, 1)
      await otherPool.query('TRUNCATE items CASCADE')
      const truncated = await get(first, inserted.etag)
      assert.equal(truncated.status, 200); assert.equal(JSON.parse(truncated.body).count, 0)
    })
  } finally {
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    process.env.DATABASE_URL = previousUrl || ''
    await otherPool?.end(); await store?.closeStore()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end()
  }
})
