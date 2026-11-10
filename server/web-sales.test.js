import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import test from 'node:test'
import { inflateSync } from 'node:zlib'
import { PDFDocument } from 'pdf-lib'
import pg from 'pg'
import { deploymentTestEnvironment } from '../scripts/test-deploy.js'
import { businessDateAt } from './cash-closure.js'
import { postgresConfig } from './postgres.js'

test('verified web confirmations, daily reconciliation and tickets share one saved sale', {
  skip: !process.env.TEST_DATABASE_URL, timeout: 30000,
}, async t => {
  const schema = 'verify_web_' + randomUUID().replaceAll('-', '')
  const url = new URL(process.env.TEST_DATABASE_URL)
  const db = new pg.Client(postgresConfig(url.href))
  await db.connect()
  let app
  t.after(async () => {
    if (app && app.exitCode === null && app.signalCode === null) {
      const exit = once(app, 'exit')
      app.kill()
      await exit
    }
    try { await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) } finally { await db.end() }
  })
  await db.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`)
  url.searchParams.set('options', `-c search_path=${schema}`)
  app = spawn(process.execPath, ['server/index.js'], { env: {
    ...deploymentTestEnvironment(process.env), DATABASE_URL: url.href, PORT: '0', HOST: '127.0.0.1',
    SESSION_SECRET: randomUUID(), INVENTORY_API_ENABLED: 'true', INVENTORY_API_ENVIRONMENT: 'test', INVENTORY_RESERVATIONS_ENABLED: 'true',
  } })
  let logs = ''
  app.stderr.on('data', chunk => { logs += chunk })
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`POS startup timed out: ${logs}`)), 10000)
    app.once('exit', () => { clearTimeout(timeout); reject(new Error(`POS exited: ${logs}`)) })
    app.stdout.on('data', chunk => {
      const port = /listening on port (\d+)/.exec(String(chunk))?.[1]
      if (port) { clearTimeout(timeout); resolve(port) }
    })
  })
  let cookie, token
  const request = (path, { method = 'GET', data, key, integration = false } = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { ...(integration ? { Authorization: `Bearer ${token}` } : cookie ? { Cookie: cookie } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) },
    body: data ? JSON.stringify(data) : undefined,
  })
  const post = (path, data, key) => request(path, { method: 'POST', data, key })
  const setup = await post('/api/auth/setup', { username: 'web-test', name: 'Admin test', password: 'Web-test-only-2026' })
  assert.equal(setup.status, 200)
  cookie = setup.headers.get('set-cookie').split(';')[0]
  const integration = await post('/api/integration-clients', { name: 'Web test', expiresInDays: 30, reservationsEnabled: true })
  assert.equal(integration.status, 201)
  token = (await integration.json()).token
  const item = await (await post('/api/items', { name: 'Pan <prueba>', category: 'Bread', unit: 'pieces',
    quantity: 10, lowStockThreshold: 0, price: 1500, sellable: true })).json()
  const reservations = '/api/integrations/v1/reservations'
  const change = (path, data, key = randomUUID()) => request(reservations + path, { integration: true, method: 'POST', data, key })
  const reserve = async (externalReference, quantity = '2.00') => {
    const response = await change('', { externalReference, expectedTotal: Number(quantity) * 1500, currency: 'CLP',
      items: [{ itemId: item.id, quantity, unit: 'pieces', unitPrice: 1500 }] })
    assert.equal(response.status, 201)
    const held = await response.json()
    const paymentAttemptId = randomUUID()
    assert.equal((await change(`/${held.id}/payment-pending`, { paymentAttemptId })).status, 200)
    return { id: held.id, body: { paymentAttemptId, paymentReference: `sandbox:${externalReference}`, amount: held.total.amount, currency: 'CLP' } }
  }
  const order = await reserve('checkout-web-test')
  await db.query("UPDATE items SET name='Nombre nuevo',price=1700 WHERE id=$1", [item.id])
  const confirmPath = `/${order.id}/confirm`
  const approvedAt = new Date().toISOString()
  const details = { status: 'approved', orderReference: 'ORD-test-101', paymentId: 'PAY-test-101', approvedAt,
    shippingAmount: 900, chargedTotal: 3900 }
  const body = { ...order.body, paymentDetails: details }
  const status = () => request(`${reservations}/${order.id}`, { integration: true }).then(r => r.json())
  assert.equal((await status()).saleId, null)
  for (const pending of ['pending', 'rejected']) {
    assert.equal((await change(confirmPath, { ...body, paymentDetails: { ...details, status: pending } })).status, 400)
  }
  assert.equal((await change(confirmPath, { ...body, paymentDetails: { ...details, chargedTotal: 5000 } })).status, 409)
  const confirmKey = randomUUID()
  await db.query("ALTER TABLE sale_items ADD CONSTRAINT test_force_sale_failure CHECK (item_name <> 'Pan <prueba>')")
  assert.equal((await change(confirmPath, body, confirmKey)).status, 503)
  assert.equal((await status()).status, 'payment_pending')
  assert.equal((await status()).saleId, null)
  await db.query('ALTER TABLE sale_items DROP CONSTRAINT test_force_sale_failure')

  const responses = await Promise.all(Array.from({ length: 4 }, () => change(confirmPath, body, confirmKey)))
  assert.ok(responses.every(response => response.status === 200))
  const confirmed = await Promise.all(responses.map(response => response.json()))
  const saleId = confirmed[0].saleId
  assert.match(saleId, /^[0-9a-f-]{36}$/)
  assert.ok(confirmed.every(result => result.saleId === saleId && result.status === 'confirmed' && result.total.amount === 3000))
  assert.equal(confirmed.filter(result => result.replayed).length, 3)
  assert.equal((await change(confirmPath, body).then(r => r.json())).saleId, saleId)
  assert.equal((await change(confirmPath, { ...body, paymentDetails: { ...details, shippingAmount: 0, chargedTotal: 3000 } })).status, 409)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sales WHERE reservation_id=$1', [order.id])).rows[0].n, 1)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM movements WHERE reservation_id=$1', [order.id])).rows[0].n, 1)
  assert.equal(Number((await db.query('SELECT quantity FROM items WHERE id=$1', [item.id])).rows[0].quantity), 8)

  const day = businessDateAt()
  const history = await request(`/api/sales/history?method=web&from=${day}&to=${day}&search=PAY-test-101`).then(r => r.json())
  assert.equal(history.total, 1)
  const sale = await request(`/api/sales/${saleId}`).then(r => r.json())
  assert.deepEqual(history.sales[0], sale)
  assert.equal(sale.channel, 'web')
  assert.equal(sale.cashierId, null)
  assert.equal(sale.registerSessionId, null)
  assert.equal(sale.pointPayment, false)
  assert.equal(sale.paidAt, approvedAt)
  assert.deepEqual(sale.items.map(({ name, quantity, unitPrice, lineTotal }) => ({ name, quantity, unitPrice, lineTotal })),
    [{ name: 'Pan <prueba>', quantity: 2, unitPrice: 1500, lineTotal: 3000 }])
  assert.equal(sale.web.subtotal, 3000)
  assert.equal(sale.web.shippingAmount, 900)
  assert.equal(sale.total, 3900)
  const ticket = await request(`/api/sales/${saleId}/ticket`)
  assert.equal(ticket.status, 200)
  assert.match(ticket.headers.get('cache-control'), /no-store/)
  const html = await ticket.text()
  for (const text of ['PRUEBA', 'checkout-web-test', 'ORD-test-101', 'PAY-test-101', 'Pan &lt;prueba&gt;', '2 × $1.500',
    '$3.000', 'Despacho</td><td>$900', 'Total cobrado</td><td>$3.900', 'Reimprimir']) assert.ok(html.includes(text), text)
  assert.equal(await request(`/api/sales/${saleId}/ticket`).then(r => r.text()), html)
  assert.equal((await post(`/api/sales/${saleId}/refunds`, { amount: 3900 }, randomUUID())).status, 409)

  const register = await post('/api/register-sessions', { openingCash: 1000 }).then(r => r.json())
  await db.query("UPDATE items SET name='Pan <prueba>',price=1500 WHERE id=$1", [item.id])
  const cashSale = await post('/api/sales/cash/local', { items: [{ itemId: item.id, quantity: 1 }], cashReceived: 1500 }, randomUUID())
  assert.equal(cashSale.status, 201)
  const physical = await request(`/api/register-sessions/${register.id}/closure`).then(r => r.json())
  assert.equal(physical.live.web, undefined)
  assert.equal(physical.live.net, 1500)
  const daily = await request(`/api/cash-closures?date=${day}`).then(r => r.json())
  assert.equal(daily.live.web.net, 3900)
  assert.equal(daily.live.cash.net, 1500)
  assert.equal(daily.live.card.net, 0)
  assert.equal(daily.live.net, 5400)
  const saved = await post('/api/cash-closures', { businessDate: day, openingCash: 1000, countedCash: 2500,
    cashIn: 0, cashOut: 0, operator: 'Admin test', expectedRevision: 0, fingerprint: daily.live.fingerprint }).then(r => r.json())
  assert.equal(saved.webSales, 3900)
  assert.equal(saved.expectedCash, 2500)
  assert.equal(saved.difference, 0)
  const response = await request(`/api/cash-closures/${day}/pdf?revision=1`)
  assert.equal(response.status, 200)
  const pdf = await PDFDocument.load(await response.arrayBuffer())
  const pdfText = pdf.getPages().flatMap(page => page.node.Contents().asArray()).flatMap(ref =>
    [...inflateSync(pdf.context.lookup(ref).getContents()).toString('latin1').matchAll(/<([a-fA-F0-9]+)>\s*Tj/g)]
      .map(match => Buffer.from(match[1], 'hex').toString('latin1'))).join('\n')
  assert.match(pdfText, /Web \(1\)/)
  for (const amount of ['$3.900', '$900', '$2.500', '$5.400']) assert.ok(pdfText.includes(amount), amount)

  const legacyIntegration = await post('/api/integration-clients', { name: 'Checkout anterior', expiresInDays: 30, reservationsEnabled: true })
  assert.equal(legacyIntegration.status, 201)
  token = (await legacyIntegration.json()).token
  const old = await reserve('checkout-legacy', '1.00')
  const oldPath = `/${old.id}/confirm`
  const reused = await change(oldPath, { ...old.body, paymentReference: body.paymentReference })
  assert.equal(reused.status, 409)
  assert.equal((await reused.json()).error.code, 'PAYMENT_ALREADY_USED')
  const oldKey = randomUUID()
  const legacy = await change(oldPath, old.body, oldKey).then(r => r.json())
  assert.match(legacy.saleId, /^[0-9a-f-]{36}$/)
  assert.equal((await request(`/api/sales/${legacy.saleId}`).then(r => r.json())).web.chargedTotal, null)
  const enriched = await change(oldPath, { ...old.body, paymentDetails: { ...details, orderReference: 'ORD-test-102',
    paymentId: 'PAY-test-102', shippingAmount: 0, chargedTotal: 1500 } }).then(r => r.json())
  assert.equal(enriched.saleId, legacy.saleId)
  assert.equal((await change(oldPath, old.body, oldKey).then(r => r.json())).saleId, legacy.saleId)
})
