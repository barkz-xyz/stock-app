import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import pg from 'pg'
import { postgresConfig } from './postgres.js'

for (const postgres of [false, true]) test(`cash Point checkout preserves payment identity and drawer accounting (${postgres ? 'PostgreSQL' : 'JSON'})`,
  { skip: postgres && !process.env.TEST_DATABASE_URL, timeout: 30000 }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bakery-cash-point-'))
    const schema = `verify_cash_point_${crypto.randomUUID().replaceAll('-', '')}`
    let admin, child, provider, mode = 'valid'
    const requests = [], orders = new Map()
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DATABASE_|TEST_DATABASE|MIGRATION_|RAILWAY_|STAFF_PIN$|APP_USERNAME$|APP_PASSWORD$|SESSION_SECRET$|MERCADOPAGO_|INVENTORY_|POINT_|PG)/.test(key)))
    Object.assign(env, { NODE_ENV: 'test', PORT: '0', DATA_PATH: path.join(directory, 'data.json'), SEED_DEMO_DATA: 'false',
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'), MERCADOPAGO_MOCK: 'false',
      MERCADOPAGO_ACCESS_TOKEN: 'local-cash-test-token', MERCADOPAGO_POINT_TERMINAL_ID: 'LOCAL-CASH-POINT',
      MERCADOPAGO_CASH_ENABLED: 'true', MERCADOPAGO_CASH_TAX_CONDITION: 'payment_exempt_iva' })
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited }
      if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }
      if (admin) { try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) } finally { await admin.end() } }
      await fs.rm(directory, { recursive: true, force: true })
    })
    if (postgres) {
      admin = new pg.Client(postgresConfig(process.env.TEST_DATABASE_URL)); await admin.connect()
      await admin.query(`CREATE SCHEMA "${schema}"`)
      await admin.query(`SET search_path TO "${schema}"`)
      const isolated = new URL(process.env.TEST_DATABASE_URL)
      isolated.searchParams.set('options', `-c search_path=${schema}`)
      env.DATABASE_URL = isolated.href
    }
    provider = http.createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString('utf8'), body = raw ? JSON.parse(raw) : null
      const key = req.headers['x-idempotency-key']
      requests.push({ method: req.method, path: req.url, key, body })
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'POST' && req.url === '/v1/orders') {
        if (mode === 'rejected') { res.statusCode = 422; return res.end(JSON.stringify({ message: 'Cash is not enabled for this merchant.', code: 'cash_not_enabled' })) }
        if (!orders.has(key)) orders.set(key, {
          id: `LOCAL-ORDER-${key}`, external_reference: body.external_reference, status: 'created', status_detail: 'created',
          transactions: { payments: [{ id: `LOCAL-PAY-${key}`, status: 'created', status_detail: 'created' }] },
        })
        if (mode === 'uncertain') { res.statusCode = 503; return res.end('{"message":"Confirmation lost after accepting order"}') }
        res.statusCode = 201; return res.end(JSON.stringify(orders.get(key)))
      }
      const order = [...orders.values()].find(o => req.url.startsWith(`/v1/orders/${o.id}`))
      if (order && req.method === 'POST' && req.url.endsWith('/cancel')) {
        order.status = 'canceled'; order.status_detail = 'canceled'
        return res.end(JSON.stringify(order))
      }
      if (order && req.method === 'GET') return res.end(JSON.stringify(order))
      res.statusCode = 404; res.end('{"message":"Unexpected local fixture request"}')
    })
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
    env.MERCADOPAGO_API_BASE = `http://127.0.0.1:${provider.address().port}`
    child = spawn(process.execPath, ['server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let logs = ''
    child.stderr.on('data', chunk => { logs += chunk })
    const port = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Local app startup timeout: ${logs}`)), 10000)
      child.once('error', error => { clearTimeout(timeout); reject(error) })
      child.once('exit', () => { clearTimeout(timeout); reject(new Error(`Local app exited: ${logs}`)) })
      child.stdout.on('data', chunk => {
        logs += chunk
        const match = /listening on port (\d+)/.exec(logs)
        if (match) { clearTimeout(timeout); resolve(Number(match[1])) }
      })
    })
    let cookie = ''
    const request = async (route, method = 'GET', body, key) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body) })
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0]
      return { status: response.status, body: await response.json() }
    }
    const expireLease = async id => {
      if (admin) await admin.query('UPDATE sales SET point_order_lease_until=NULL WHERE id=$1', [id])
      else { const data = JSON.parse(await fs.readFile(env.DATA_PATH, 'utf8')); data.sales.find(s => s.id === id).pointOrderLeaseUntil = 0; await fs.writeFile(env.DATA_PATH, JSON.stringify(data)) }
    }
    assert.equal((await request('/api/auth/setup', 'POST', { username: 'cash-test', name: 'Cash Test', password: crypto.randomBytes(24).toString('hex') })).status, 200)
    const session = (await request('/api/register-sessions', 'POST', { openingCash: 100 })).body
    const config = (await request('/api/pos/config')).body
    assert.equal(config.cashEnabled, true); assert.equal(config.mockMode, false)
    const item = (await request('/api/items', 'POST', { name: 'Local cash bread', category: 'Bread', unit: 'pieces', quantity: 10, lowStockThreshold: 0, price: 1000, sellable: true })).body
    const stock = async () => (await request('/api/items')).body.find(i => i.id === item.id).quantity
    const drawer = async () => (await request('/api/register-cash')).body.balance
    const cart = { items: [{ itemId: item.id, quantity: 1 }], cashReceived: 2000 }, key = crypto.randomUUID()
    assert.equal((await request('/api/sales/cash', 'POST', { ...cart, cashReceived: 500 }, crypto.randomUUID())).status, 400)
    assert.equal(requests.length, 0)

    const initial = await request('/api/sales/cash', 'POST', cart, key)
    assert.equal(initial.status, 201)
    const sale = initial.body
    assert.equal(sale.status, 'pending'); assert.equal(sale.paymentMethod, 'cash'); assert.equal(sale.pointPayment, true)
    assert.equal(sale.pointTaxCondition, 'payment_exempt_iva'); assert.equal(sale.paidAt, null)
    assert.equal(sale.cashReceived, 2000); assert.equal(sale.cashChange, 1000)
    assert.equal(await stock(), 9); assert.equal(await drawer(), 100)
    assert.equal(requests[0].key, sale.id)
    assert.deepEqual(requests[0].body.config.payment_method, { default_type: 'cash' })
    assert.deepEqual(requests[0].body.config.point, { terminal_id: 'LOCAL-CASH-POINT', print_on_terminal: 'seller_ticket' })
    assert.deepEqual(requests[0].body.transactions.payments, [{ amount: '1000' }], 'Send the sale total, not tendered cash or change')
    assert.deepEqual(requests[0].body.taxes, [{ payer_condition: 'payment_exempt_iva' }])
    const work = (await request(`/api/register-sessions/${session.id}/closure`)).body
    assert.equal(work.live.pendingCount, 1)
    assert.equal((await request(`/api/register-sessions/${session.id}/closure`, 'POST', { countedCash: 100, fingerprint: work.live.fingerprint, expectedRevision: 0 })).body.code, 'PENDING_PAYMENTS')
    const duplicate = await Promise.all([request('/api/sales/cash', 'POST', cart, key), request('/api/sales/cash', 'POST', cart, key)])
    assert.ok(duplicate.every(r => r.body.id === sale.id)); assert.equal(requests.length, 1)
    assert.equal((await request('/api/sales/cash', 'POST', { ...cart, cashReceived: 3000 }, key)).status, 409)
    const order = orders.get(sale.id)
    order.status = 'processed'; order.status_detail = 'accredited'
    Object.assign(order.transactions.payments[0], { status: 'processed', status_detail: 'accredited', reference_id: '10000001', payment_method: { id: 'cash', type: 'cash' } })
    const approved = (await request(`/api/sales/${sale.id}?refresh=true`)).body
    assert.equal(approved.status, 'paid'); assert.equal(approved.paymentMethod, 'cash'); assert.ok(approved.paidAt)
    assert.equal(await stock(), 9); assert.equal(await drawer(), 1100)
    await request(`/api/sales/${sale.id}/reconcile-point`, 'POST')
    assert.equal(await drawer(), 1100); assert.equal(await stock(), 9)
    assert.equal(requests.some(r => r.path.startsWith('/v1/payments/')), false, 'Cash is not enriched as a card settlement')
    assert.equal((await request(`/api/sales/${sale.id}/retry-point`, 'POST')).status, 409)

    const pending = (await request('/api/sales/cash', 'POST', cart, crypto.randomUUID())).body
    assert.equal(await stock(), 8)
    assert.equal((await request(`/api/sales/${pending.id}/cancel`, 'POST')).body.status, 'cancelled')
    await request(`/api/sales/${pending.id}/reconcile-point`, 'POST')
    assert.equal(await stock(), 9); assert.equal(await drawer(), 1100)

    mode = 'rejected'
    const rejected = await request('/api/sales/cash', 'POST', cart, crypto.randomUUID())
    assert.equal(rejected.status, 422)
    assert.equal((await request(`/api/sales/${rejected.body.saleId}`)).body.status, 'failed')
    assert.equal(await stock(), 9); assert.equal(await drawer(), 1100)

    mode = 'uncertain'
    const uncertainKey = crypto.randomUUID()
    const uncertain = await request('/api/sales/cash', 'POST', cart, uncertainKey)
    assert.equal(uncertain.status, 503); assert.equal(uncertain.body.uncertain, true)
    const uncertainId = uncertain.body.saleId
    assert.equal((await request(`/api/sales/${uncertainId}`)).body.status, 'pending')
    assert.equal(await stock(), 8); assert.equal(await drawer(), 1100)
    await request('/api/sales/cash', 'POST', cart, uncertainKey)
    assert.equal(requests.filter(r => r.key === uncertainId).length, 1)
    await expireLease(uncertainId); mode = 'valid'
    assert.equal((await request(`/api/sales/${uncertainId}/retry-point`, 'POST')).body.mpOrderId, orders.get(uncertainId).id)
    const attempts = requests.filter(r => r.key === uncertainId)
    assert.equal(attempts.length, 2); assert.deepEqual(attempts[1].body, attempts[0].body)
    await request(`/api/sales/${uncertainId}/cancel`, 'POST')
    assert.equal(await stock(), 9); assert.equal(await drawer(), 1100)

    const refund = await request(`/api/sales/${sale.id}/refunds`, 'POST', { amount: 400, items: [], restock: false }, crypto.randomUUID())
    assert.equal(refund.status, 201); assert.equal(refund.body.refundedTotal, 400)
    assert.equal(await drawer(), 700)
    assert.equal(requests.some(r => r.path.endsWith('/refund')), false, 'Return cash from the drawer, not a card refund API')
    assert.equal(requests.some(r => r.path === '/terminals/v1/actions'), false, 'Use native printing; never manufacture an invoice or folio')

    assert.equal((await request('/api/users', 'POST', { username: 'cashier-test', name: 'Cashier Test', role: 'cashier', password: 'Initial-Cashier-2026' })).status, 201)
    assert.equal((await request('/api/auth/login', 'POST', { username: 'cashier-test', password: 'Initial-Cashier-2026' })).status, 200)
    assert.equal((await request('/api/auth/password', 'POST', { currentPassword: 'Initial-Cashier-2026', password: 'Personal-Cashier-2026' })).status, 200)
    assert.equal((await request('/api/register-sessions', 'POST', { openingCash: 0 })).status, 200)
    assert.equal((await request(`/api/sales/${sale.id}/retry-point`, 'POST')).status, 404, 'Cashiers cannot recover another operator sale')
    mode = 'uncertain'
    const cashierSale = await request('/api/sales/cash', 'POST', cart, crypto.randomUUID())
    assert.equal(cashierSale.body.uncertain, true)
    await expireLease(cashierSale.body.saleId); mode = 'valid'
    assert.equal((await request(`/api/sales/${cashierSale.body.saleId}/retry-point`, 'POST')).status, 200, 'Cashiers can recover their own cash Point sale')
    assert.equal((await request(`/api/sales/${cashierSale.body.saleId}/cancel`, 'POST')).body.status, 'cancelled')
    assert.equal(await stock(), 9)
  })
