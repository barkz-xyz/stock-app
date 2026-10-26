import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('staff and inventory identities stay isolated; only administrators can manage integration credentials', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bakery-inventory-access-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DATABASE_|DATA_PATH$|PORT$|STAFF_PIN$|APP_|SESSION_SECRET$|MERCADOPAGO_|POINT_|RAILWAY_|INVENTORY_)/.test(key)))
  Object.assign(env, { PORT: '0', NODE_ENV: 'test', DATA_PATH: path.join(directory, 'inventory.json'),
    APP_USERNAME: 'admin', APP_PASSWORD: 'Inventory-Admin-1234', STAFF_PIN: 'Inventory-Admin-1234', SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    INVENTORY_API_ENABLED: 'true', INVENTORY_API_ENVIRONMENT: 'test', SEED_DEMO_DATA: 'false', MERCADOPAGO_MOCK: 'false' })
  let child, logs = ''
  const start = async () => {
    child = spawn(process.execPath, ['server/index.js'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stderr.on('data', chunk => { logs += chunk })
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('API server startup timed out')), 15000)
      child.once('error', error => { clearTimeout(timeout); reject(error) })
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`API server exited ${code}`)) })
      child.stdout.on('data', chunk => { logs += chunk; const match = /listening on port (\d+)/.exec(String(chunk)); if (match) { clearTimeout(timeout); resolve(`http://127.0.0.1:${match[1]}`) } })
    })
  }
  const stop = async () => { if (child?.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited } }
  t.after(async () => { await stop(); await fs.rm(directory, { recursive: true, force: true }) })
  let base = await start()
  const request = (route, { body, cookie, token, method = body ? 'POST' : 'GET' } = {}) => fetch(`${base}${route}`, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  let login = await request('/api/auth/login', { body: { username: env.APP_USERNAME, password: env.APP_PASSWORD } })
  assert.equal(login.status, 200)
  let adminCookie = login.headers.get('set-cookie').split(';')[0]
  const changed = await request('/api/auth/password', { cookie: adminCookie, body: { currentPassword: env.APP_PASSWORD, password: 'Inventory-New-Admin-1234' } })
  assert.equal(changed.status, 200); adminCookie = changed.headers.get('set-cookie').split(';')[0]
  assert.equal((await request('/api/integration-clients')).status, 401)
  const issuedResponse = await request('/api/integration-clients', { cookie: adminCookie, body: { name: 'External store', expiresInDays: 30 } })
  assert.equal(issuedResponse.status, 201)
  assert.equal(issuedResponse.headers.get('cache-control'), 'private, no-store')
  const issued = await issuedResponse.json()
  assert.match(issued.token, /^bpos_test_/)
  assert.equal((await request('/api/integrations/v1/inventory', { cookie: adminCookie })).status, 401)
  for (const route of ['/api/items', '/api/users', '/api/sales', '/api/cash-closures', '/api/integration-clients']) {
    assert.equal((await request(route, { token: issued.token })).status, 401)
  }
  const malformed = await request('/api/integration-clients/not-uuid/keys', { cookie: adminCookie, body: {} })
  assert.equal(malformed.status, 400)
  assert.equal((await request('/api/integration-clients', { cookie: adminCookie, body: { name: 'Overbroad', scopes: ['*'] } })).status, 400)
  assert.equal((await request('/api/integration-clients', { cookie: adminCookie, body: { name: 'Invalid', expiresInDays: 0 } })).status, 400)
  const itemResponse = await request('/api/items', { cookie: adminCookie, body: { name: 'Unsold', category: 'Bread', unit: 'pieces', quantity: 0, lowStockThreshold: 0, price: 1200, sellable: true } })
  assert.equal(itemResponse.status, 201)
  const before = await fs.readFile(env.DATA_PATH, 'utf8')
  const inventory = await request('/api/integrations/v1/inventory', { token: issued.token })
  assert.equal(inventory.status, 200)
  assert.equal((await inventory.json()).count, 0, 'Zero stock stays in POS but is omitted from the online inventory')
  const zeroItem = await itemResponse.json()
  assert.equal((await request(`/api/integrations/v1/inventory/${zeroItem.id}`,{token:issued.token})).status,404)
  const after = await fs.readFile(env.DATA_PATH, 'utf8')
  assert.equal(after, before)
  await request('/api/users', { cookie: adminCookie, body: { username: 'inventory.cashier', name: 'Cashier', role: 'cashier', password: 'Inventory-Cashier-1234' } })
  login = await request('/api/auth/login', { body: { username: 'inventory.cashier', password: 'Inventory-Cashier-1234' } })
  let cashierCookie = login.headers.get('set-cookie').split(';')[0]
  const cashierChanged = await request('/api/auth/password', { cookie: cashierCookie, body: { currentPassword: 'Inventory-Cashier-1234', password: 'Inventory-New-Cashier-1234' } })
  cashierCookie = cashierChanged.headers.get('set-cookie').split(';')[0]
  assert.equal((await request('/api/integration-clients', { cookie: cashierCookie })).status, 403)
  assert.equal((await request('/api/integration-clients', { cookie: cashierCookie, body: { name: 'Denied' } })).status, 403)
  assert.equal((await request('/api/stock-reservations', { cookie: cashierCookie })).status, 403)
  assert.equal((await request(`/api/integration-clients/${issued.client.id}`, { cookie: cashierCookie, method: 'PATCH', body: { reservationsEnabled: true } })).status, 403)
  const grant = await request(`/api/integration-clients/${issued.client.id}`, { cookie: adminCookie, method: 'PATCH', body: { reservationsEnabled: true } })
  assert.equal(grant.status, 200)
  assert.ok((await (await request('/api/integration-clients', { cookie: adminCookie })).json()).clients[0].scopes.includes('inventory:reserve'))
  for (const route of [`/api/integration-clients/${issued.client.id}`, `/api/integration-clients/${issued.client.id}/keys/${issued.key.id}`]) {
    assert.equal((await request(route, { method: 'DELETE' })).status, 401)
    assert.equal((await request(route, { cookie: cashierCookie, method: 'DELETE' })).status, 403)
    assert.equal((await request(route, { token: issued.token, method: 'DELETE' })).status, 401)
  }
  assert.equal((await request('/api/integration-clients/not-uuid', { cookie: adminCookie, method: 'DELETE' })).status, 400)
  assert.equal((await request(`/api/integration-clients/${issued.client.id}/keys/${crypto.randomUUID()}`, { cookie: adminCookie, method: 'DELETE' })).status, 404)
  const metadata = await (await request('/api/integration-clients', { cookie: adminCookie })).json()
  assert.equal(metadata.clients.length, 1)
  assert.doesNotMatch(JSON.stringify(metadata), /token_hash|tokenHash/)
  assert.ok(!JSON.stringify(metadata).includes(issued.token))
  await stop()
  base = await start()
  assert.equal((await request('/api/integrations/v1/inventory', { token: issued.token })).status, 200, 'Keys survive process restarts')
  const revoke = await request(`/api/integration-clients/${issued.client.id}/keys/${issued.key.id}/revoke`, { cookie: adminCookie, body: {} })
  assert.equal(revoke.status, 200)
  assert.equal((await request('/api/integrations/v1/inventory', { token: issued.token })).status, 401)
  const beforeCredentialChanges = await fs.readFile(env.DATA_PATH, 'utf8')
  const rotatedResponse = await request(`/api/integration-clients/${issued.client.id}/keys`, { cookie: adminCookie, body: { expiresInDays: 90 } })
  assert.equal(rotatedResponse.status, 201)
  const rotated = await rotatedResponse.json()
  assert.match(rotated.token, /^bpos_test_[A-Za-z0-9_-]{43}$/, 'Renewal returns a complete secret exactly when it is generated')
  const deleteKey = await request(`/api/integration-clients/${issued.client.id}/keys/${rotated.key.id}`, { cookie: adminCookie, method: 'DELETE' })
  assert.equal(deleteKey.status, 200)
  assert.equal((await request('/api/integrations/v1/inventory', { token: rotated.token })).status, 401)
  const deleteClient = await request(`/api/integration-clients/${issued.client.id}`, { cookie: adminCookie, method: 'DELETE' })
  assert.equal(deleteClient.status, 200)
  assert.deepEqual((await (await request('/api/integration-clients', { cookie: adminCookie })).json()).clients, [])
  assert.equal(await fs.readFile(env.DATA_PATH, 'utf8'), beforeCredentialChanges, 'Credential deletion never modifies inventory or sales data')
  assert.ok(!logs.includes(issued.token), 'Request logs never contain the secret')
})
