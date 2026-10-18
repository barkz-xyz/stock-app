import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import crypto from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

test('HTTP authentication rejects malformed sessions and validates product calendar dates', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bakery-http-'))
  const secret = crypto.randomBytes(32).toString('hex')
  const env = { ...process.env, PORT: '0', DATA_PATH: path.join(directory, 'inventory.json'),
    STAFF_PIN: '7351', SESSION_SECRET: secret, SEED_DEMO_DATA: 'false', MERCADOPAGO_MOCK: 'false' }
  delete env.DATABASE_URL
  delete env.MERCADOPAGO_ACCESS_TOKEN
  delete env.MERCADOPAGO_POINT_TERMINAL_ID
  const pendingId = crypto.randomUUID()
  await fs.writeFile(env.DATA_PATH, JSON.stringify({ items: [], movements: [], cashClosures: [], sales: [{
    id: pendingId, status: 'pending', paymentMethod: 'card', total: 1000, mpOrderId: `DEMO-${pendingId}`,
    inventoryApplied: true, items: [], refunds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }] }))
  for (const key of Object.keys(env)) if (key.startsWith('RAILWAY_')) delete env[key]
  const child = spawn(process.execPath, ['server/index.js'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  child.stderr.on('data', (chunk) => { logs += chunk })
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
    await fs.rm(directory, { recursive: true, force: true })
  })
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${logs}`)), 10000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Server exited: ${logs}`)) })
    child.stdout.on('data', (chunk) => {
      logs += chunk
      const match = /listening on port (\d+)/.exec(logs)
      if (match) { clearTimeout(timer); resolve(Number(match[1])) }
    })
  })
  const base = `http://127.0.0.1:${port}`
  const request = (route, options = {}) => fetch(`${base}${route}`, options)
  const assertPrivate = (response) => {
    assert.match(response.headers.get('cache-control'), /private/)
    assert.match(response.headers.get('vary'), /Cookie/i)
  }
  for (const route of ['/api/health', '/api/auth/status', '/api/items', '/api/bootstrap']) {
    const response = await request(route)
    assertPrivate(response)
    assert.match(response.headers.get('cache-control'), /no-store/)
    await response.arrayBuffer()
  }
  const malformedJson = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })
  assert.equal(malformedJson.status, 400)
  assertPrivate(malformedJson)
  await malformedJson.arrayBuffer()
  const missingAsset = await request('/assets/does-not-exist.js')
  assert.equal(missingAsset.status, 404)
  assert.equal(missingAsset.headers.get('cache-control'), 'private, no-store')
  assert.match(missingAsset.headers.get('content-type'), /application\/json/)
  await missingAsset.arrayBuffer()
  const unauthenticatedBootstrap = await request('/api/bootstrap')
  assert.equal(unauthenticatedBootstrap.headers.get('cache-control'), 'private, no-store')
  const locked = await unauthenticatedBootstrap.json()
  assert.equal(locked.auth.authenticated, false)
  assert.deepEqual(Object.keys(locked), ['auth'])
  assert.equal((await request('/api/items', { headers: { Cookie: 'bakery_session=%' } })).status, 401)
  assert.equal((await request('/api/auth/status', { headers: { Cookie: 'a=%ZZ' } })).status, 200)
  const signedCookie = (expiry) => `bakery_session=${expiry}.${crypto.createHmac('sha256', secret).update(expiry).digest('base64url')}`
  assert.equal((await request('/api/items', { headers: { Cookie: signedCookie('NaN') } })).status, 401)
  assert.equal((await request('/api/items', { headers: { Cookie: signedCookie('1') } })).status, 401)
  const login = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '7351' }) })
  assert.equal(login.status, 200)
  assertPrivate(login)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const builtHtml = await fs.readFile(path.join('dist', 'index.html'), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null })
  await t.test('built HTML shell is shared safely while versioned assets remain immutable', { skip: !builtHtml }, async () => {
    for (const route of ['/', '/index.html', '/resumen', '/caja', '/caja/historial', '/caja/cierre?fecha=2026-10-17', '/inventario', '/metricas?periodo=30d', '/actividad', '/configuracion']) {
      const anonymous = await request(route)
      const authenticated = await request(route, { headers: { Cookie: cookie } })
      assert.equal(anonymous.status, 200)
      assert.equal(anonymous.headers.get('cache-control'), 'public, max-age=0, s-maxage=60, stale-while-revalidate=300')
      assert.doesNotMatch(anonymous.headers.get('vary') || '', /Cookie/i)
      assert.equal(anonymous.headers.get('set-cookie'), null)
      assert.equal(await anonymous.text(), builtHtml)
      assert.equal(await authenticated.text(), builtHtml)
    }
    const asset = builtHtml.match(/src="(\/assets\/index-[^"]+\.js)"/)[1]
    const response = await request(asset)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    assert.match(response.headers.get('content-type'), /javascript/)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await fs.readFile(path.join('dist', asset)))
  })
  const bootstrap = await request('/api/bootstrap', { headers: { Cookie: cookie } })
  const initial = await bootstrap.json()
  assert.equal(initial.auth.authenticated, true)
  assert.deepEqual(initial.items, [])
  assert.deepEqual(initial.movements, [])
  assert.equal(initial.sales[0].id, pendingId)
  assert.equal(initial.posConfig.credentialsExposedToClient, false)
  assert.match(bootstrap.headers.get('server-timing'), /^data;dur=\d/)
  const history = await request('/api/sales?limit=50', { headers: { Cookie: cookie } })
  const etag = history.headers.get('etag')
  assert.ok(etag)
  assert.equal(history.headers.get('cache-control'), 'private, no-cache')
  assertPrivate(history)
  await history.arrayBuffer()
  const unchanged = await request('/api/sales?limit=50', { cache: 'no-cache', headers: { Cookie: cookie, 'If-None-Match': etag } })
  assert.equal(unchanged.status, 304)
  assertPrivate(unchanged)
  assert.equal((await unchanged.arrayBuffer()).byteLength, 0)
  const pending = await request(`/api/sales/${pendingId}?refresh=true`, { headers: { Cookie: cookie } })
  assert.equal(pending.status, 200)
  assert.equal((await pending.json()).status, 'pending')
  assert.equal((await request('/api/items', { headers: { Cookie: `a=%ZZ; ${cookie}` } })).status, 200)
  const product = { name: 'Calendar test', category: 'Bread', unit: 'pieces', quantity: 3, price: 1000, sellable: true }
  for (const expiryDate of ['not-a-date', '2026-02-30', '2026-13-01', '2026-10-17garbage', true]) {
    const response = await request('/api/items', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...product, expiryDate }) })
    assert.equal(response.status, 400, `Rejected invalid expiry date: ${expiryDate}`)
  }
  assert.equal((await (await request('/api/items', { headers: { Cookie: cookie } })).json()).length, 0)
  assert.equal((await request('/api/items', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...product, expiryDate: '2028-02-29' }) })).status, 201)
  const [created] = await (await request('/api/items', { headers: { Cookie: cookie } })).json()
  const sale = await request('/api/sales/cash', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ itemId: created.id, quantity: 1 }] }) })
  assert.equal(sale.status, 201)
  const changedHistory = await request('/api/sales?limit=50', { cache: 'no-cache', headers: { Cookie: cookie, 'If-None-Match': etag } })
  assert.equal(changedHistory.status, 200)
  assert.notEqual(changedHistory.headers.get('etag'), etag)
  const updatedBootstrap = await (await request('/api/bootstrap', { headers: { Cookie: cookie } })).json()
  assert.equal(updatedBootstrap.items[0].quantity, 2)
  assert.equal(updatedBootstrap.sales.length, 2)
  await t.test('cash close requires authentication, rejects stale writes and serves a private compressed PDF', async () => {
    assert.equal((await request('/api/cash-closures')).status, 401)
    assert.equal((await request('/api/cash-closures/2026-10-17/pdf')).status, 401)
    assert.equal((await request('/api/cash-closures?date=2026-02-30', { headers: { Cookie: cookie } })).status, 400)
    const workspace = await (await request('/api/cash-closures', { headers: { Cookie: cookie } })).json()
    const declaration = { businessDate: workspace.live.businessDate, openingCash: 0, cashIn: 0, cashOut: 0,
      countedCash: workspace.live.cash.net, countedCard: workspace.live.card.net, operator: 'HTTP tester',
      expectedRevision: 0, fingerprint: workspace.live.fingerprint, note: 'Isolated HTTP close.' }
    const write = () => request('/api/cash-closures', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(declaration) })
    const saved = await write()
    assert.equal(saved.status, 200)
    assertPrivate(saved)
    assert.equal((await saved.json()).revision, 1)
    assert.equal((await write()).status, 409)
    const pdf = await request(`/api/cash-closures/${declaration.businessDate}/pdf?revision=1`, { headers: { Cookie: cookie } })
    assert.equal(pdf.status, 200)
    assertPrivate(pdf)
    assert.equal(pdf.headers.get('cache-control'), 'private, no-store')
    assert.equal(pdf.headers.get('content-type'), 'application/pdf')
    assert.match(pdf.headers.get('content-disposition'), /v1.pdf/)
    const bytes = Buffer.from(await pdf.arrayBuffer())
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-')
    assert.ok(bytes.length < 50000)
    assert.match(bytes.toString('latin1'), /FlateDecode/)
    assert.equal((await request('/api/cash-closures/2020-01-01/pdf', { headers: { Cookie: cookie } })).status, 404)
  })
  await t.test('two sessions receive stock changes and checkout retries consume inventory once', async (t) => {
    const aborts = [new AbortController(), new AbortController()]
    t.after(() => aborts.forEach(controller => controller.abort()))
    const streams = await Promise.all(aborts.map(controller => request('/api/events', { headers: { Cookie: cookie }, signal: controller.signal })))
    for (const stream of streams) {
      assert.equal(stream.status, 200)
      assertPrivate(stream)
      assert.equal(stream.headers.get('content-encoding'), null)
      assert.match(stream.headers.get('content-type'), /text\/event-stream/)
    }
    const readers = streams.map(stream => stream.body.getReader())
    const waitEvent = async (reader, event) => {
      let received = ''
      while (!received.includes(`event: ${event}\n`)) {
        const chunk = await reader.read()
        assert.equal(chunk.done, false)
        received += new TextDecoder().decode(chunk.value)
      }
      assert.doesNotMatch(received, /itemId|quantity|bakery_session/)
    }
    await Promise.all(readers.map(reader => waitEvent(reader, 'ready')))
    const adjusted = await request(`/api/items/${created.id}/adjust`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'adjustment', quantity: 6, note: 'Two-device test' }) })
    assert.equal(adjusted.status, 200)
    await Promise.all(readers.map(reader => waitEvent(reader, 'change')))
    const before = await (await request('/api/bootstrap', { headers: { Cookie: cookie } })).json()
    const key = crypto.randomUUID()
    const post = (quantity, method = 'cash') => request(`/api/sales/${method}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ items: [{ itemId: created.id, quantity }] }) })
    const replies = await Promise.all(Array.from({ length: 8 }, () => post(2)))
    assert.equal(replies.filter(reply => reply.status === 201).length, 1)
    assert.equal(replies.filter(reply => reply.status === 200).length, 7)
    const sales = await Promise.all(replies.map(reply => reply.json()))
    assert.equal(new Set(sales.map(sale => sale.id)).size, 1)
    assert.ok(sales.every(sale => sale.checkoutKey === key))
    const conflict = await post(1)
    assert.equal(conflict.status, 409)
    assert.equal((await conflict.json()).code, 'CHECKOUT_CONFLICT')
    const recovered = await request(`/api/checkouts/${key}`, { headers: { Cookie: cookie } })
    assertPrivate(recovered)
    assert.equal((await recovered.json()).id, sales[0].id)
    assert.equal((await request(`/api/checkouts/${key}`)).status, 401)
    assert.equal((await request('/api/events')).status, 401)
    const after = await (await request('/api/bootstrap', { headers: { Cookie: cookie } })).json()
    assert.equal(after.items[0].quantity, 4)
    assert.equal(after.sales.length, before.sales.length + 1)
    assert.equal(after.movements.length, before.movements.length + 1)
    assert.equal(after.dailySummary.transactions, before.dailySummary.transactions + 1)
    assert.equal(after.dailySummary.revenue, before.dailySummary.revenue + 2000)
  })
  for (let attempt = 0; attempt < 9; attempt++) {
    const response = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `192.0.2.${attempt}` }, body: JSON.stringify({ pin: 'wrong' }) })
    assert.equal(response.status, attempt < 8 ? 401 : 429)
  }
})

test('staff authentication requires an independent session secret', async () => {
  await assert.rejects(promisify(execFile)(process.execPath, ['--input-type=module', '-e', "await import('./server/auth.js')"], {
    env: { ...process.env, STAFF_PIN: '7351', SESSION_SECRET: '' }, windowsHide: true,
  }), (error) => error.stderr.includes('SESSION_SECRET is required'))
})
