import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('uncertain Point charges and refunds recover with their original identity and retain stock', { timeout: 30000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bakery-payment-recovery-'))
  const requests = [], orders = new Map(), refunds = new Map()
  let createResult = 'unavailable', refundResult = 'unavailable', readResult = 'valid', paid = false
  const provider = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8')
    const body = text ? JSON.parse(text) : null
    const key = request.headers['x-idempotency-key']
    requests.push({ method: request.method, url: request.url, key, body })
    response.setHeader('Content-Type', 'application/json')
    const reply = (mode, data) => {
      if (mode === 'unavailable') {
        response.statusCode = 503
        return response.end(JSON.stringify({ message: 'Local fixture lost confirmation after accepting the operation.' }))
      }
      if (mode === 'rejected' || mode === 'unauthorized') {
        response.statusCode = mode === 'unauthorized' ? 401 : 422
        return response.end(JSON.stringify({ message: 'Local fixture rejected the order.', code: 'invalid_order' }))
      }
      if (mode === 'malformed') return response.end('{')
      if (mode === 'truncated') {
        response.setHeader('Content-Length', '4096')
        response.flushHeaders()
        response.write('{"id":')
        return setImmediate(() => response.destroy())
      }
      response.end(JSON.stringify(data))
    }
    if (request.method === 'POST' && request.url === '/v1/orders') {
      if (['rejected', 'unauthorized'].includes(createResult)) return reply(createResult)
      if (!orders.has(key)) orders.set(key, {
        id: `ORDER-${key}`, status: 'created', status_detail: 'created', external_reference: body.external_reference,
        transactions: { payments: [{ id: `PAY-${key}`, status: 'created', status_detail: 'created' }] },
      })
      response.statusCode = 201
      return reply(createResult, orders.get(key))
    }
    const order = [...orders.values()].find((entry) => request.url.startsWith(`/v1/orders/${entry.id}`))
    if (request.method === 'GET' && order) {
      const result = structuredClone(order)
      if (paid) {
        result.status = 'processed'; result.status_detail = 'accredited'
        Object.assign(result.transactions.payments[0], { status: 'processed', status_detail: 'accredited' })
      }
      if (refunds.size) result.transactions.refunds = [...refunds.values()].map((entry) => ({
        ...entry, ...(refundResult === 'processing' ? { status: 'processing' } : {}),
      }))
      if (readResult === 'wrong-order') return reply('valid', { id: 'UNRELATED-ORDER', status: 'failed' })
      if (readResult === 'other-refund') result.transactions.refunds = [{ id: 'UNRELATED-REFUND', amount: '500', status: 'processed' }]
      if (readResult === 'multiple-refunds') result.transactions.refunds.push({ id: 'UNRELATED-REFUND', amount: '500', status: 'processed' })
      return reply(readResult, result)
    }
    if (request.method === 'POST' && order && request.url.endsWith('/refund')) {
      if (!refunds.has(key)) refunds.set(key, { id: `REF-${key}`, amount: body?.transactions?.[0]?.amount || '1000', status: 'processed' })
      const confirmation = { ...refunds.get(key), ...(refundResult === 'processing' ? { status: 'processing' } : {}) }
      response.statusCode = 201
      return reply(refundResult, {
        ...order, status: 'processed', status_detail: 'partially_refunded',
        transactions: { ...order.transactions, refunds: [confirmation] },
      })
    }
    response.statusCode = 404
    response.end(JSON.stringify({ error: 'unexpected_local_request' }))
  })
  provider.listen(0, '127.0.0.1')
  await once(provider, 'listening')
  // Never inherit real database connections, payment credentials, or staff setup.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DATABASE_|TEST_DATABASE|RAILWAY_|STAFF_PIN$|APP_USERNAME$|APP_PASSWORD$|SESSION_SECRET$|MERCADOPAGO_|INVENTORY_|POINT_|PG)/.test(key)))
  Object.assign(env, {
    NODE_ENV: 'test', PORT: '0', DATA_PATH: path.join(directory, 'data.json'), SEED_DEMO_DATA: 'false',
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'), MERCADOPAGO_MOCK: 'false',
    MERCADOPAGO_ACCESS_TOKEN: 'local-test-token', MERCADOPAGO_POINT_TERMINAL_ID: 'LOCAL-TERMINAL',
    MERCADOPAGO_API_BASE: `http://127.0.0.1:${provider.address().port}`,
  })
  const child = spawn(process.execPath, ['server/index.js'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  child.stderr.on('data', (chunk) => { logs += chunk })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill(); await exited
    }
    provider.closeAllConnections()
    await new Promise((resolve) => provider.close(resolve))
    await fs.rm(directory, { recursive: true, force: true })
  })
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Local app startup timeout: ${logs}`)), 10000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Local app exited: ${logs}`)) })
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
  const expireLease = async (saleId) => {
    // Advance only this disposable fixture's durable lease instead of sleeping.
    const data = JSON.parse(await fs.readFile(env.DATA_PATH, 'utf8'))
    data.sales.find((sale) => sale.id === saleId).pointOrderLeaseUntil = 0
    await fs.writeFile(env.DATA_PATH, JSON.stringify(data))
  }
  assert.equal((await request('/api/auth/setup', 'POST', {
    username: 'local-audit', name: 'Local Audit', password: crypto.randomBytes(24).toString('hex'),
  })).status, 200)
  assert.equal((await request('/api/register-sessions', 'POST', { openingCash: 0 })).status, 200)
  const created = await request('/api/items', 'POST', {
    name: 'Local test bread', category: 'Bread', unit: 'pieces', price: 1000, quantity: 3, lowStockThreshold: 0, sellable: true,
  })
  assert.equal(created.status, 201)
  const item = created.body
  const stock = async () => (await request('/api/items')).body.find((entry) => entry.id === item.id).quantity
  const cart = { items: [{ itemId: item.id, quantity: 1 }] }, checkoutKey = crypto.randomUUID()
  const checkout = await request('/api/sales/card', 'POST', cart, checkoutKey)
  assert.equal(checkout.status, 503)
  assert.equal(checkout.body.uncertain, true)
  const saleId = checkout.body.saleId
  let sale = (await request(`/api/sales/${saleId}`)).body
  assert.equal(sale.status, 'pending'); assert.equal(sale.inventoryApplied, true); assert.equal(await stock(), 2)
  const replay = await request('/api/sales/card', 'POST', cart, checkoutKey)
  assert.equal(replay.status, 200); assert.equal(replay.body.id, saleId)
  assert.equal(requests.length, 1, 'Checkout replay must not send another provider write')
  // A later rejection cannot establish that the earlier accepted operation
  // failed. Keep its reservation until an authoritative order status is known.
  for (const mode of ['unauthorized', 'rejected']) {
    createResult = mode
    await expireLease(saleId)
    const retry = await request(`/api/sales/${saleId}/retry-card`, 'POST')
    assert.equal(retry.status, 502); assert.equal(retry.body.uncertain, true)
    sale = (await request(`/api/sales/${saleId}`)).body
    assert.equal(sale.status, 'pending'); assert.equal(sale.inventoryApplied, true); assert.equal(await stock(), 2)
  }
  createResult = 'valid'
  await expireLease(saleId)
  const retried = await request(`/api/sales/${saleId}/retry-card`, 'POST')
  assert.equal(retried.status, 200); assert.equal(retried.body.mpOrderId, `ORDER-${saleId}`)
  assert.equal(orders.size, 1); assert.equal(await stock(), 2)
  const chargeRequests = requests.filter((entry) => entry.url === '/v1/orders')
  assert.deepEqual(chargeRequests.map((entry) => entry.key), [saleId, saleId, saleId, saleId])
  assert.ok(chargeRequests.every((entry) => JSON.stringify(entry.body) === JSON.stringify(chargeRequests[0].body)))
  for (const mode of ['unavailable', 'malformed', 'truncated', 'wrong-order']) {
    readResult = mode
    const refresh = await request(`/api/sales/${saleId}?refresh=true`)
    assert.equal(refresh.status, mode === 'unavailable' ? 503 : 502)
    assert.equal((await request(`/api/sales/${saleId}`)).body.status, 'pending')
    assert.equal(await stock(), 2)
  }
  readResult = 'valid'; paid = true
  const approval = await request(`/api/sales/${saleId}?refresh=true`)
  assert.equal(approval.status, 200); assert.equal(approval.body.status, 'paid')
  const writesBeforeInvalidRetry = requests.length
  assert.equal((await request(`/api/sales/${saleId}/retry-card`, 'POST')).status, 409)
  assert.equal((await request(`/api/sales/${saleId}`)).body.status, 'paid')
  assert.equal(requests.length, writesBeforeInvalidRetry); assert.equal(await stock(), 2)
  readResult = 'unavailable'
  assert.equal((await request(`/api/sales/${saleId}/reconcile-point`, 'POST')).status, 503)
  assert.equal((await request(`/api/sales/${saleId}`)).body.status, 'paid')
  readResult = 'valid'

  const refundKey = crypto.randomUUID()
  const firstRefund = await request(`/api/sales/${saleId}/refunds`, 'POST', { amount: 500, items: [], restock: false }, refundKey)
  assert.equal(firstRefund.status, 503); assert.equal(firstRefund.body.uncertain, true)
  const refundId = firstRefund.body.refundId
  assert.ok(refundId)
  const pendingRefund = async () => {
    const current = (await request(`/api/sales/${saleId}`)).body
    assert.equal(current.status, 'paid'); assert.equal(current.refundedTotal, 0)
    assert.equal(current.refunds.length, 1); assert.equal(current.refunds[0].id, refundId); assert.equal(current.refunds[0].status, 'pending')
    assert.equal(await stock(), 2)
  }
  await pendingRefund()
  const pendingReplay = await request(`/api/sales/${saleId}/refunds`, 'POST', { amount: 500, items: [], restock: false }, refundKey)
  assert.equal(pendingReplay.status, 202); assert.equal(pendingReplay.body.refunds[0].id, refundId)
  assert.equal(requests.filter((entry) => entry.url.endsWith('/refund')).length, 1, 'Replaying an initial refund request must not submit another provider operation')
  const duplicateRefund = await request(`/api/sales/${saleId}/refunds`, 'POST', { amount: 500, items: [], restock: false }, crypto.randomUUID())
  assert.equal(duplicateRefund.status, 409); assert.equal(refunds.size, 1)
  for (const mode of ['malformed', 'truncated', 'processing']) {
    refundResult = mode
    const retry = await request(`/api/sales/${saleId}/refunds/${refundId}/retry`, 'POST')
    assert.equal(retry.status, 502); assert.equal(retry.body.uncertain, true)
    await pendingRefund()
  }
  sale = (await request(`/api/sales/${saleId}`)).body
  assert.equal(sale.refunds[0].mpRefundId, `REF-${refundId}`, 'Persist the accepted provider refund identity before polling')
  for (const mode of ['unavailable', 'malformed', 'truncated', 'other-refund']) {
    readResult = mode
    const retry = await request(`/api/sales/${saleId}/refunds/${refundId}/retry`, 'POST')
    assert.equal(retry.status, 502); assert.equal(retry.body.uncertain, true)
    await pendingRefund()
  }
  refundResult = 'valid'
  readResult = 'multiple-refunds'
  const recovered = await request(`/api/sales/${saleId}/refunds/${refundId}/retry`, 'POST')
  assert.equal(recovered.status, 200)
  assert.equal(recovered.body.refundedTotal, 500); assert.equal(recovered.body.refunds[0].status, 'processed')
  assert.equal(refunds.size, 1); assert.equal(await stock(), 2)
  const refundRequests = requests.filter((entry) => entry.url.endsWith('/refund'))
  assert.equal(refundRequests.length, 4, 'Poll the known provider refund instead of resubmitting it')
  assert.ok(refundRequests.every((entry) => entry.key === refundId))
  assert.ok(refundRequests.every((entry) => JSON.stringify(entry.body) === JSON.stringify(refundRequests[0].body)))
  assert.equal((await request(`/api/sales/${saleId}/refunds/${refundId}/retry`, 'POST')).status, 409)

  createResult = 'rejected'
  const rejection = await request('/api/sales/card', 'POST', cart, crypto.randomUUID())
  assert.equal(rejection.status, 422); assert.equal(Boolean(rejection.body.uncertain), false)
  sale = (await request(`/api/sales/${rejection.body.saleId}`)).body
  assert.equal(sale.status, 'failed'); assert.equal(sale.inventoryApplied, false); assert.equal(await stock(), 2)
  assert.equal((await request(`/api/sales/${sale.id}/retry-card`, 'POST')).status, 409)
  const cashSale = await request('/api/sales/cash', 'POST', { ...cart, cashReceived: 1000 }, crypto.randomUUID())
  assert.equal(cashSale.status, 201); assert.equal(await stock(), 1)
  assert.equal((await request(`/api/sales/${cashSale.body.id}/retry-card`, 'POST')).status, 409)
  assert.equal((await request(`/api/sales/${cashSale.body.id}`)).body.status, 'paid')
  assert.equal(await stock(), 1)
})
