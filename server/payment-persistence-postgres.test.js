import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { once } from 'node:events'
import http from 'node:http'
import test from 'node:test'
import pg from 'pg'
import { postgresConfig } from './postgres.js'

test('accepted Point writes survive local persistence failures without releasing stock or duplicating refunds', {
  skip: !process.env.TEST_DATABASE_URL, timeout: 30000,
}, async (t) => {
  const schema = `verify_payment_persist_${crypto.randomUUID().replaceAll('-', '')}`
  const admin = new pg.Client(postgresConfig(process.env.TEST_DATABASE_URL))
  await admin.connect()
  let child, provider
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill(); await exited
    }
    if (provider) {
      provider.closeAllConnections()
      await new Promise((resolve) => provider.close(resolve))
    }
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) } finally { await admin.end() }
  })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  await admin.query(`SET search_path TO "${schema}"`)
  const requests = [], orders = new Map(), providerRefunds = new Map()
  let approved = false
  provider = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8'), body = raw ? JSON.parse(raw) : null
    const key = request.headers['x-idempotency-key']
    requests.push({ method: request.method, path: request.url, key, body })
    response.setHeader('Content-Type', 'application/json')
    if (request.method === 'POST' && request.url === '/v1/orders') {
      if (!orders.has(key)) orders.set(key, {
        id: `LOCAL-ORDER-${key}`, external_reference: body.external_reference, status: 'created', status_detail: 'created',
        transactions: { payments: [{ id: `LOCAL-PAY-${key}`, status: 'created', status_detail: 'created' }] },
      })
      response.statusCode = 201
      return response.end(JSON.stringify(orders.get(key)))
    }
    const order = [...orders.values()].find((entry) => request.url.startsWith(`/v1/orders/${entry.id}`))
    if (!order) { response.statusCode = 404; return response.end('{"error":"unexpected_local_request"}') }
    const result = structuredClone(order)
    if (approved) {
      result.status = 'processed'; result.status_detail = 'accredited'
      Object.assign(result.transactions.payments[0], { status: 'processed', status_detail: 'accredited' })
    }
    if (request.method === 'POST' && request.url.endsWith('/refund')) {
      if (!providerRefunds.has(key)) providerRefunds.set(key, { id: `LOCAL-REFUND-${key}`, amount: body.transactions[0].amount, status: 'processed' })
      response.statusCode = 201
    }
    if (providerRefunds.size) {
      result.status_detail = 'partially_refunded'
      result.transactions.refunds = [...providerRefunds.values()]
    }
    response.end(JSON.stringify(result))
  })
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
  const isolated = new URL(process.env.TEST_DATABASE_URL)
  isolated.searchParams.set('options', `-c search_path=${schema} -c statement_timeout=10000`)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DATABASE_|TEST_DATABASE|RAILWAY_|STAFF_PIN$|APP_USERNAME$|APP_PASSWORD$|SESSION_SECRET$|MERCADOPAGO_|INVENTORY_|POINT_)/.test(key)))
  Object.assign(env, {
    NODE_ENV: 'test', PORT: '0', DATABASE_URL: isolated.href, SEED_DEMO_DATA: 'false',
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'), MERCADOPAGO_MOCK: 'false',
    MERCADOPAGO_ACCESS_TOKEN: 'local-persist-fixture', MERCADOPAGO_POINT_TERMINAL_ID: 'LOCAL-TERMINAL',
    MERCADOPAGO_API_BASE: `http://127.0.0.1:${provider.address().port}`,
  })
  child = spawn(process.execPath, ['server/index.js'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  child.stderr.on('data', (chunk) => { logs += chunk })
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Local PostgreSQL app startup timeout: ${logs}`)), 10000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Local PostgreSQL app exited: ${logs}`)) })
    child.stdout.on('data', (chunk) => {
      logs += chunk
      const match = /listening on port (\d+)/.exec(logs)
      if (match) { clearTimeout(timer); resolve(Number(match[1])) }
    })
  })
  let cookie = ''
  const request = async (route, method = 'GET', body, key) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0]
    return { status: response.status, body: await response.json() }
  }
  assert.equal((await request('/api/auth/setup', 'POST', { username: 'local-persist', name: 'Local Persist', password: crypto.randomBytes(24).toString('hex') })).status, 200)
  assert.equal((await request('/api/register-sessions', 'POST', { openingCash: 0 })).status, 200)
  const item = await request('/api/items', 'POST', { name: 'Isolated bread', category: 'Bread', unit: 'pieces', quantity: 3, price: 1000, sellable: true, lowStockThreshold: 0 })
  assert.equal(item.status, 201)
  const stock = async () => Number((await admin.query('SELECT quantity FROM items WHERE id=$1', [item.body.id])).rows[0].quantity)
  await admin.query(`CREATE FUNCTION fixture_fail_point_attach() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Local fixture refused to persist the accepted provider order'; END $$;
    CREATE TRIGGER fixture_fail_point_attach BEFORE UPDATE ON sales FOR EACH ROW
    WHEN (NEW.mp_order_id IS NOT NULL AND OLD.mp_order_id IS NULL)
    EXECUTE FUNCTION fixture_fail_point_attach()`)
  const checkout = await request('/api/sales/card', 'POST', { items: [{ itemId: item.body.id, quantity: 1 }] }, crypto.randomUUID())
  assert.equal(checkout.status, 502); assert.equal(checkout.body.uncertain, true)
  const saleId = checkout.body.saleId
  const pending = async () => {
    const current = (await request(`/api/sales/${saleId}`)).body
    assert.equal(current.status, 'pending'); assert.equal(current.mpOrderId, null); assert.equal(current.inventoryApplied, true)
    assert.equal(await stock(), 2)
  }
  await pending()
  const expireLease = () => admin.query("UPDATE sales SET point_order_lease_until=NOW()-INTERVAL '1 second' WHERE id=$1", [saleId])
  await expireLease()
  const failedRetry = await request(`/api/sales/${saleId}/retry-card`, 'POST')
  assert.equal(failedRetry.status, 502); assert.equal(failedRetry.body.uncertain, true)
  await pending()
  await admin.query('DROP TRIGGER fixture_fail_point_attach ON sales')
  await expireLease()
  assert.equal((await request(`/api/sales/${saleId}/retry-card`, 'POST')).status, 200)
  assert.equal(orders.size, 1); assert.equal(await stock(), 2)
  assert.deepEqual(requests.filter((entry) => entry.path === '/v1/orders').map((entry) => entry.key), [saleId, saleId, saleId])
  approved = true
  const approval = await request(`/api/sales/${saleId}?refresh=true`)
  assert.equal(approval.status, 200); assert.equal(approval.body.status, 'paid')

  await admin.query(`CREATE FUNCTION fixture_fail_refund_complete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Local fixture refused to complete the accepted provider refund'; END $$;
    CREATE TRIGGER fixture_fail_refund_complete BEFORE UPDATE ON refunds FOR EACH ROW
    WHEN (NEW.status='processed' AND OLD.status='pending') EXECUTE FUNCTION fixture_fail_refund_complete()`)
  const refund = await request(`/api/sales/${saleId}/refunds`, 'POST', { amount: 500, items: [], restock: false }, crypto.randomUUID())
  assert.equal(refund.status, 502); assert.equal(refund.body.uncertain, true)
  const refundId = refund.body.refundId
  const pendingRefund = async () => {
    const current = (await request(`/api/sales/${saleId}`)).body
    assert.equal(current.status, 'paid'); assert.equal(current.refundedTotal, 0)
    assert.equal(current.refunds.length, 1); assert.equal(current.refunds[0].status, 'pending')
    assert.equal(current.refunds[0].mpRefundId, `LOCAL-REFUND-${refundId}`)
    assert.equal(await stock(), 2)
  }
  await pendingRefund()
  const refundRetry = await request(`/api/sales/${saleId}/refunds/${refundId}/retry`, 'POST')
  assert.equal(refundRetry.status, 502); assert.equal(refundRetry.body.uncertain, true)
  await pendingRefund()
  await admin.query('DROP TRIGGER fixture_fail_refund_complete ON refunds')
  const recovered = await request(`/api/sales/${saleId}/refunds/${refundId}/retry`, 'POST')
  assert.equal(recovered.status, 200); assert.equal(recovered.body.refundedTotal, 500)
  assert.equal(recovered.body.refunds.length, 1); assert.equal(recovered.body.refunds[0].status, 'processed')
  assert.equal(providerRefunds.size, 1); assert.equal(await stock(), 2)
  assert.equal(requests.filter((entry) => entry.path.endsWith('/refund')).length, 1, 'A known accepted refund is polled instead of sent again')
})
