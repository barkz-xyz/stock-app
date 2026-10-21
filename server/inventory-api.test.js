import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import express from 'express'
import { once } from 'node:events'
import { createIntegrationStore, tokenDigest } from './integration-store.js'
import { createInventoryRouter, inventoryApiConfiguration, inventoryItem, inventoryRepresentation } from './inventory-api.js'

const fixture = overrides => ({ id: crypto.randomUUID(), sku: '', name: 'Pan', category: 'Bread', unit: 'pieces',
  quantity: '0.00', price: '1200', sellable: false, expiry_date: null, updated_at: '2026-10-20T10:00:00Z', ...overrides })

test('inventory contract preserves decimals, CLP, all products and stable canonical representations', () => {
  const rows = [fixture({ quantity: '9999999999.99', price: '999999999999', expiry_date: '2026-11-01' }), fixture({ quantity: '1.20', sellable: true })]
  const encoded = inventoryRepresentation(rows)
  assert.deepEqual(inventoryRepresentation([...rows].reverse()), encoded)
  const snapshot = JSON.parse(encoded.body)
  assert.equal(snapshot.complete, true); assert.equal(snapshot.count, 2)
  assert.equal(snapshot.items.find(item => item.id === rows[0].id).stockQuantity, '9999999999.99')
  assert.equal(snapshot.items.find(item => item.id === rows[1].id).stockQuantity, '1.20')
  assert.equal(snapshot.items[0].sku, null)
  assert.equal(snapshot.items[0].price.currency, 'CLP')
  assert.equal(inventoryItem(rows[0]).expiryDate, '2026-11-01')
  assert.equal(inventoryItem(rows[0]).updatedAt, '2026-10-20T10:00:00.000Z')
  assert.equal(inventoryRepresentation([]).body, '{"apiVersion":"1","inventoryPoolId":"global","complete":true,"count":0,"items":[]}')
  assert.notEqual(inventoryRepresentation([{ ...rows[0], price: 100 }]).etag, inventoryRepresentation([rows[0]]).etag)
  assert.notEqual(inventoryRepresentation([{ ...rows[0], quantity: '1.00' }]).etag, inventoryRepresentation([rows[0]]).etag)
  for (const invalid of [null, -1, 'bad', 1.234, 10000000000]) assert.throws(() => inventoryItem(fixture({ quantity: invalid })))
  for (const invalid of [-1, 1.5, 1000000000000]) assert.throws(() => inventoryItem(fixture({ price: invalid })))
  assert.deepEqual(Object.keys(inventoryItem(fixture({ passwordHash: 'secret', movements: ['private'], lowStockThreshold: 99 }))).sort(),
    ['id', 'sku', 'name', 'category', 'unit', 'stockQuantity', 'price', 'sellable', 'expiryDate', 'updatedAt'].sort())
})

test('inventory API is opt-in and environment credentials are separate', () => {
  assert.deepEqual(inventoryApiConfiguration({}), { enabled: false, environment: 'test', production: false, reservationsEnabled: false, reservationTtlSeconds: 900 })
  assert.equal(inventoryApiConfiguration({ NODE_ENV: 'production', INVENTORY_API_ENABLED: 'true' }).environment, 'production')
  assert.equal(inventoryApiConfiguration({ NODE_ENV: 'production', INVENTORY_API_ENVIRONMENT: 'test' }).environment, 'test')
  assert.throws(() => inventoryApiConfiguration({ INVENTORY_API_ENVIRONMENT: 'invalid' }))
})

test('local keys persist only hashes, rotate with overlap, enforce limits and revoke without touching inventory', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bakery-integrations-'))
  const dataPath = path.join(directory, 'inventory.json')
  await fs.writeFile(dataPath, '{"items":[],"movements":[],"sales":[]}')
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const options = { pool: null, dataPath, readInventory: async () => [] }
  const store = createIntegrationStore(options)
  const issued = await store.createClient({ name: 'Store', environment: 'test', expiresInDays: 90, createdBy: crypto.randomUUID() })
  assert.match(issued.token, /^bpos_test_[A-Za-z0-9_-]{43}$/)
  assert.doesNotMatch(await fs.readFile(`${dataPath}.integrations.json`, 'utf8'), new RegExp(issued.token))
  assert.equal((await createIntegrationStore(options).authenticate(tokenDigest(issued.token), 'test')).id, issued.client.id)
  assert.equal(await store.authenticate(tokenDigest(issued.token), 'production'), null)
  const rotated = await store.rotateKey(issued.client.id, 'test', 30)
  assert.ok(await store.authenticate(tokenDigest(issued.token), 'test'))
  const [client] = await store.listClients('test')
  assert.ok(Date.parse(client.keys.find(key => key.id === issued.key.id).expiresAt) <= Date.now() + 86401000)
  await assert.rejects(store.rotateKey(client.id, 'test', 30), { code: 'KEY_ROTATION_CONFLICT' })
  await store.revokeKey(client.id, issued.key.id, 'test')
  await store.revokeKey(client.id, issued.key.id, 'test')
  assert.equal(await store.authenticate(tokenDigest(issued.token), 'test'), null)
  assert.ok(await store.authenticate(tokenDigest(rotated.token), 'test'))
  assert.doesNotMatch(JSON.stringify(await store.listClients('test')), /tokenHash|token_hash|bpos_test_[A-Za-z0-9_-]{43}/)
  const limits = await Promise.all(Array.from({ length: 12 }, () => store.consumeLimits([{ key: 'shared', seconds: 3600, limit: 5 }])))
  assert.equal(limits.filter(value => value === 0).length, 5)
  const production = await store.createClient({ name: 'Other environment', environment: 'production', expiresInDays: 30 })
  await assert.rejects(store.deleteKey(client.id, rotated.key.id, 'production'), { status: 404 })
  await assert.rejects(store.deleteKey(client.id, production.key.id, 'test'), { status: 404 })
  await assert.rejects(store.deleteClient(client.id, 'production'), { status: 404 })
  await store.deleteKey(client.id, issued.key.id, 'test')
  assert.equal((await store.listClients('test'))[0].keys.length, 1)
  assert.ok(await store.authenticate(tokenDigest(rotated.token), 'test'), 'Deleting one key leaves the other usable')
  await store.deleteKey(client.id, rotated.key.id, 'test')
  assert.equal(await store.authenticate(tokenDigest(rotated.token), 'test'), null)
  assert.equal((await store.listClients('test'))[0].keys.length, 0)
  const replacement = await store.rotateKey(client.id, 'test', 30)
  await store.consumeLimits([{ key: `client:${client.id}:minute`, seconds: 60, limit: 60 }])
  await store.deleteClient(client.id, 'test')
  assert.deepEqual(await store.listClients('test'), [])
  assert.equal(await store.authenticate(tokenDigest(replacement.token), 'test'), null)
  const remaining = await fs.readFile(`${dataPath}.integrations.json`, 'utf8')
  assert.ok(!remaining.includes(client.id) && !remaining.includes(tokenDigest(replacement.token)))
  assert.ok(await store.authenticate(tokenDigest(production.token), 'production'))
  assert.equal(await fs.readFile(dataPath, 'utf8'), '{"items":[],"movements":[],"sales":[]}')
})

test('HTTP integration verifies auth before 304, remains read-only and fails closed on outages', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bakery-inventory-http-'))
  const rows = [fixture(), fixture({ quantity: '3.25', sellable: true, sku: 'PAN-1' })]
  let failInventory = false, consume = true
  const store = createIntegrationStore({ pool: null, dataPath: path.join(directory, 'stock'), readInventory: async id => {
    if (failInventory) throw new Error('postgres password=do-not-leak')
    return id ? rows.filter(row => row.id === id.toLowerCase()) : rows
  } })
  const limited = store.consumeLimits.bind(store)
  store.consumeLimits = entries => consume ? limited(entries) : 0
  const issued = await store.createClient({ name: 'HTTP', environment: 'test', expiresInDays: 1 })
  const app = express()
  const config = { enabled: true, environment: 'test' }
  app.use('/api/integrations/v1', createInventoryRouter({ getStore: () => store, config }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${server.address().port}/api/integrations/v1`
  const request = (route = '/inventory', options = {}) => fetch(`${base}${route}`, { ...options, headers: { Authorization: `Bearer ${issued.token}`, ...options.headers } })
  const unauthorized = await request('/inventory', { headers: { Authorization: '' } })
  assert.equal(unauthorized.status, 401)
  assert.equal((await unauthorized.json()).error.requestId, unauthorized.headers.get('x-request-id'))
  assert.equal(unauthorized.headers.get('cache-control'), 'private, no-store')
  assert.match(unauthorized.headers.get('vary'), /Authorization/)
  const response = await request()
  assert.equal(response.status, 200)
  const snapshot = await response.json()
  assert.equal(snapshot.count, 2)
  assert.equal(snapshot.items.find(row => row.id === rows[0].id).sellable, false)
  const etag = response.headers.get('etag')
  const unchanged = await request('/inventory', { headers: { 'If-None-Match': etag } })
  assert.equal(unchanged.status, 304); assert.equal(await unchanged.text(), '')
  const product = await request(`/inventory/${rows[1].id.toUpperCase()}`)
  assert.equal((await product.json()).stockQuantity, '3.25')
  assert.equal((await request('/inventory/not-a-uuid')).status, 400)
  assert.equal((await request(`/inventory/${crypto.randomUUID()}`)).status, 404)
  assert.equal((await request('/inventory?limit=1')).status, 400)
  assert.equal((await request('/inventory', { method: 'POST', body: '{' })).status, 405)
  assert.equal((await request('/orders')).status, 404)
  failInventory = true
  const unavailable = await request()
  assert.equal(unavailable.status, 503)
  assert.doesNotMatch(await unavailable.text(), /password|postgres|do-not-leak/)
  failInventory = false
  consume = false
  await store.revokeKey(issued.client.id, issued.key.id, 'test')
  assert.equal((await request('/inventory', { headers: { 'If-None-Match': etag } })).status, 401)
  const second = await store.rotateKey(issued.client.id, 'test', 1)
  const file = `${path.join(directory, 'stock')}.integrations.json`
  const state = JSON.parse(await fs.readFile(file, 'utf8'))
  state.clients[0].scopes = []
  await fs.writeFile(file, JSON.stringify(state))
  assert.equal((await request('/inventory', { headers: { Authorization: `Bearer ${second.token}` } })).status, 403)
  config.enabled = false
  const disabled = await request()
  assert.equal(disabled.status, 503); assert.equal((await disabled.json()).error.code, 'API_DISABLED')
  config.enabled = true
  state.clients[0].scopes = ['inventory:read']
  state.keys.find(key => key.id === second.key.id).expiresAt = '2020-01-01T00:00:00Z'
  await fs.writeFile(file, JSON.stringify(state))
  assert.equal((await request('/inventory', { headers: { Authorization: `Bearer ${second.token}` } })).status, 401)
  consume = true
  const third = await store.rotateKey(issued.client.id, 'test', 1)
  let throttled = 0
  for (let i = 0; i < 40; i++) {
    const res = await request('/inventory', { headers: { Authorization: `Bearer ${third.token}` } })
    if (res.status === 429) { throttled++; assert.ok(Number(res.headers.get('retry-after')) >= 1) }
    await res.arrayBuffer()
  }
  assert.ok(throttled > 0)
})
