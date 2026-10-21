import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { createIntegrationStore, tokenDigest } from './integration-store.js'
import { inventoryRepresentation } from './inventory-api.js'

test('PostgreSQL inventory credentials and quotas work across independent pools without changing business rows', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const schema = `verify_inventory_${crypto.randomUUID().replaceAll('-', '')}`
  const connectionString = process.env.TEST_DATABASE_URL
  const ssl = !connectionString.includes('railway.internal') && process.env.PGSSLMODE !== 'disable' ? { rejectUnauthorized: false } : false
  const admin = new pg.Client({ connectionString, ssl })
  const previous = process.env.DATABASE_URL
  let store, secondPool
  try {
    await admin.connect()
    await admin.query(`CREATE SCHEMA "${schema}"`)
    const isolated = new URL(connectionString)
    isolated.searchParams.set('options', `-c search_path=${schema}`)
    process.env.DATABASE_URL = isolated.href
    store = await import(`./store.js?inventory=${crypto.randomUUID()}`)
    await store.initializeStore()
    const integration = store.getInventoryIntegrationStore()
    await integration.initialize()
    secondPool = new pg.Pool({ connectionString: isolated.href, ssl })
    const other = createIntegrationStore({ pool: secondPool })
    await other.initialize()
    const item = await store.createItem({ name: 'Raw decimal', category: 'Bread', unit: 'kg', quantity: 12.25, price: 1200, sellable: true, sku: '', lowStockThreshold: 0, expiryDate: '2026-12-31' })
    await store.createItem({ name: 'Not for sale', category: 'Ingredients', unit: 'kg', quantity: 0, price: 0, sellable: false, sku: '', lowStockThreshold: 0, expiryDate: null })
    const issued = await integration.createClient({ name: 'Store', environment: 'test', expiresInDays: 90, createdBy: null })
    assert.equal((await other.authenticate(tokenDigest(issued.token), 'test')).id, issued.client.id)
    assert.equal(await other.authenticate(tokenDigest(issued.token), 'production'), null)
    const before = (await secondPool.query('SELECT row_to_json(i) AS row FROM items i ORDER BY id')).rows
    const ledger = await secondPool.query('SELECT (SELECT count(*) FROM movements) AS movements,(SELECT count(*) FROM sales) AS sales')
    const exported = JSON.parse(inventoryRepresentation(await integration.readInventory()).body)
    assert.equal(exported.count, 2)
    assert.equal(exported.items.find(row => row.id === item.id).stockQuantity, '12.25')
    assert.equal(exported.items.find(row => row.id === item.id).expiryDate, '2026-12-31')
    assert.ok(exported.items.some(row => !row.sellable && row.stockQuantity === '0.00'))
    assert.equal((await integration.readInventory(item.id)).length, 1)
    const requests = await Promise.all(Array.from({ length: 30 }, (_, index) => (index % 2 ? integration : other).consumeLimits([
      { key: 'same-client:minute', seconds: 86400, limit: 7 }, { key: 'same-client:burst', seconds: 86400, limit: 20 },
    ])))
    assert.equal(requests.filter(retry => retry === 0).length, 7, 'Atomic shared counters admit exactly the quota across pools')
    const rotations = await Promise.allSettled([integration.rotateKey(issued.client.id, 'test', 90), other.rotateKey(issued.client.id, 'test', 90)])
    assert.equal(rotations.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(rotations.find(result => result.status === 'rejected').reason.code, 'KEY_ROTATION_CONFLICT')
    await other.revokeKey(issued.client.id, issued.key.id, 'test')
    assert.equal(await integration.authenticate(tokenDigest(issued.token), 'test'), null)
    const rotated = rotations.find(result => result.status === 'fulfilled').value
    await secondPool.query("UPDATE integration_keys SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [rotated.key.id])
    assert.equal(await integration.authenticate(tokenDigest(rotated.token), 'test'), null)
    const [metadata] = await other.listClients('test')
    assert.equal(metadata.keys.length, 2)
    assert.doesNotMatch(JSON.stringify(metadata), /tokenHash|token_hash/)
    const secrets = await secondPool.query('SELECT token_hash FROM integration_keys')
    assert.ok(secrets.rows.every(row => /^[a-f0-9]{64}$/.test(row.token_hash)))
    await assert.rejects(other.deleteKey(issued.client.id, issued.key.id, 'production'), { status: 404 })
    await assert.rejects(other.deleteClient(issued.client.id, 'production'), { status: 404 })
    await other.deleteKey(issued.client.id, rotated.key.id, 'test')
    assert.equal((await integration.listClients('test'))[0].keys.length, 1)
    const replacement = await integration.rotateKey(issued.client.id, 'test', 90)
    await other.deleteKey(issued.client.id, replacement.key.id, 'test')
    assert.equal(await integration.authenticate(tokenDigest(replacement.token), 'test'), null)
    const final = await integration.rotateKey(issued.client.id, 'test', 90)
    await integration.consumeLimits([{ key: `client:${issued.client.id}:minute`, seconds: 60, limit: 60 }])
    await other.deleteClient(issued.client.id, 'test')
    assert.deepEqual(await integration.listClients('test'), [])
    assert.equal(await integration.authenticate(tokenDigest(final.token), 'test'), null)
    assert.equal((await secondPool.query('SELECT count(*)::int AS count FROM integration_keys')).rows[0].count, 0)
    assert.equal((await secondPool.query('SELECT count(*)::int AS count FROM integration_rate_limits WHERE bucket LIKE $1', [`client:${issued.client.id}:%`])).rows[0].count, 0)
    const raceClient = await integration.createClient({ name: 'Concurrent deletion', environment: 'test', expiresInDays: 90 })
    const race = await Promise.allSettled([other.deleteClient(raceClient.client.id, 'test'), integration.rotateKey(raceClient.client.id, 'test', 90)])
    assert.equal(race[0].status, 'fulfilled')
    if (race[1].status === 'rejected') assert.equal(race[1].reason.code, 'NOT_FOUND')
    assert.equal((await secondPool.query('SELECT count(*)::int AS count FROM integration_keys')).rows[0].count, 0, 'Concurrent deletion and rotation cannot leave orphaned credentials')
    assert.deepEqual((await secondPool.query('SELECT row_to_json(i) AS row FROM items i ORDER BY id')).rows, before)
    assert.deepEqual((await secondPool.query('SELECT (SELECT count(*) FROM movements) AS movements,(SELECT count(*) FROM sales) AS sales')).rows, ledger.rows)
  } finally {
    process.env.DATABASE_URL = previous || ''
    await secondPool?.end()
    await store?.closeStore()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
  }
})
