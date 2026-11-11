import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { inflateSync } from 'node:zlib'
import { PDFDocument } from 'pdf-lib'
import pg from 'pg'
import { deploymentTestEnvironment } from '../scripts/test-deploy.js'
import { businessDateAt } from './cash-closure.js'
import { postgresConfig } from './postgres.js'
import { renderPointWebOrder } from './point-receipts.js'

test('large web orders preserve every line within the Point print size limit', () => {
  const items = Array.from({ length: 100 }, (_, i) => ({
    name: `Producto-${i} ${'ingrediente '.repeat(12)}`, quantity: 1.25, unitPrice: 1000,
  }))
  const parts = renderPointWebOrder({ shortId: 'TEST1234', paidAt: '2026-11-10T15:00:00Z', items,
    web: { environment: 'test', externalReference: 'checkout-large', subtotal: 125000, shippingAmount: 900, chargedTotal: 125900 },
  })
  assert.ok(parts.length > 1)
  assert.ok(parts.every(part => part.length >= 100 && part.length <= 4096 && part.includes('COMANDA WEB')))
  for (const [i, part] of parts.entries()) assert.ok(part.includes(`Parte ${i + 1}/${parts.length}`))
  for (const [i] of items.entries()) assert.equal(parts.filter(part => part.includes(`1,25 x Producto-${i} `)).length, 1)
  assert.match(parts.at(-1), /Total cobrado: \$125\.900/)
})

test('verified web confirmations, daily reconciliation and tickets share one saved sale', {
  skip: !process.env.TEST_DATABASE_URL, timeout: 30000,
}, async t => {
  const schema = 'verify_web_' + randomUUID().replaceAll('-', '')
  const url = new URL(process.env.TEST_DATABASE_URL)
  const db = new pg.Client(postgresConfig(url.href))
  await db.connect()
  let app
  const prints = []
  const actionStatuses = new Map()
  const actionLookups = []
  let rejectPrint = false
  let rejectLookup = false
  let releaseFirstPrint
  const firstPrint = new Promise(resolve => { releaseFirstPrint = resolve })
  const provider = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.method === 'GET') {
      const id = request.url.match(/^\/terminals\/v1\/actions\/(POINT-ACTION-\d+)$/)?.[1]
      actionLookups.push({ id, authorization: request.headers.authorization })
      if (rejectLookup || !actionStatuses.has(id)) {
        response.writeHead(503).end(JSON.stringify({ message: 'Point fixture unavailable' }))
      } else {
        response.end(JSON.stringify({ id, status: actionStatuses.get(id) }))
      }
      return
    }
    let raw = ''
    for await (const chunk of request) raw += chunk
    prints.push({ path: request.url, key: request.headers['x-idempotency-key'],
      authorization: request.headers.authorization, body: JSON.parse(raw) })
    const id = 'POINT-ACTION-' + prints.length
    if (prints.length === 1) await firstPrint
    if (rejectPrint || request.headers['x-idempotency-key']?.endsWith('-2')) {
      response.writeHead(422).end(JSON.stringify({ message: 'Point fixture rejected the order' }))
    } else {
      actionStatuses.set(id, 'created')
      response.writeHead(201).end(JSON.stringify({ id, status: 'created' }))
    }
  })
  t.after(async () => {
    releaseFirstPrint()
    if (app && app.exitCode === null && app.signalCode === null) {
      const exit = once(app, 'exit')
      app.kill()
      await exit
    }
    provider.closeAllConnections()
    if (provider.listening) await new Promise(resolve => provider.close(resolve))
    try { await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) } finally { await db.end() }
  })
  await db.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`)
  url.searchParams.set('options', `-c search_path=${schema}`)
  provider.listen(0, '127.0.0.1')
  await once(provider, 'listening')
  app = spawn(process.execPath, ['server/index.js'], { env: {
    ...deploymentTestEnvironment(process.env), DATABASE_URL: url.href, PORT: '0', HOST: '127.0.0.1',
    SESSION_SECRET: randomUUID(), INVENTORY_API_ENABLED: 'true', INVENTORY_API_ENVIRONMENT: 'test', INVENTORY_RESERVATIONS_ENABLED: 'true',
    MERCADOPAGO_API_BASE: `http://127.0.0.1:${provider.address().port}`,
    MERCADOPAGO_WEB_PRINT_ACCESS_TOKEN: 'test-print-only', MERCADOPAGO_WEB_PRINT_TERMINAL_ID: 'POINT-TEST-KITCHEN',
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
  const waitForPrint = async (saleId, expected) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const sale = await request(`/api/sales/${saleId}`).then(r => r.json())
      if (sale.webPrintStatus === expected) return sale
      await delay(25)
    }
    assert.fail(`Expected Point print status ${expected}`)
  }
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
  assert.equal(prints.length, 0)
  await db.query('ALTER TABLE sale_items DROP CONSTRAINT test_force_sale_failure')

  const responses = await Promise.all(Array.from({ length: 4 }, () => change(confirmPath, body, confirmKey)))
  assert.ok(responses.every(response => response.status === 200))
  const confirmed = await Promise.all(responses.map(response => response.json()))
  const saleId = confirmed[0].saleId
  assert.match(saleId, /^[0-9a-f-]{36}$/)
  assert.ok(confirmed.every(result => result.saleId === saleId && result.status === 'confirmed' && result.total.amount === 3000))
  assert.equal(confirmed.filter(result => result.replayed).length, 3)
  releaseFirstPrint()
  await waitForPrint(saleId, 'submitted')
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
  assert.deepEqual(sale.webPrintActions, [{ id: 'POINT-ACTION-1', status: 'created', requestId: saleId, part: 1, parts: 1 }])
  assert.equal(prints.length, 1, 'Replaying a confirmation must never send another Point action')
  assert.equal(prints[0].path, '/terminals/v1/actions')
  assert.equal(prints[0].key, saleId)
  assert.equal(prints[0].authorization, 'Bearer test-print-only')
  assert.equal(prints[0].body.type, 'print')
  assert.deepEqual(prints[0].body.config, { point: { terminal_id: 'POINT-TEST-KITCHEN', subtype: 'custom' } })
  for (const text of ['COMANDA WEB', 'PRUEBA', 'Uso interno', 'checkout-web-test', '2 x Pan <prueba>',
    'Precio unit.: $1.500', 'Subtotal: $3.000', 'Despacho: $900', 'Total cobrado: $3.900']) {
    assert.ok(prints[0].body.content.includes(text), text)
  }
  assert.doesNotMatch(prints[0].body.content, /PAY-test-101|ORD-test-101/)
  const readSale = (refresh = false) => request(`/api/sales/${saleId}${refresh ? '?refresh=true' : ''}`).then(r => r.json())
  actionStatuses.set('POINT-ACTION-1', 'on_terminal')
  assert.equal((await readSale(true)).webPrintActions[0].status, 'on_terminal')
  assert.equal((await readSale()).webPrintActions[0].status, 'on_terminal')
  assert.deepEqual(actionLookups, [{ id: 'POINT-ACTION-1', authorization: 'Bearer test-print-only' }])
  rejectLookup = true
  const unavailable = await readSale(true)
  assert.equal(unavailable.webPrintRefreshFailed, true)
  assert.equal(unavailable.webPrintActions[0].status, 'on_terminal')
  rejectLookup = false
  actionStatuses.set('POINT-ACTION-1', 'processed')
  assert.equal((await readSale(true)).webPrintActions[0].status, 'processed')
  assert.equal(prints.length, 1, 'Reading the Point status must never print again')

  const printPath = `/api/sales/${saleId}/print-web-order`
  const reprintKey = randomUUID()
  for (const key of [reprintKey, reprintKey, saleId]) {
    const result = await post(printPath, undefined, key)
    assert.equal(result.status, 202)
    const printed = await result.json()
    assert.equal(printed.pointPrint, 'submitted')
    assert.deepEqual(printed.webPrintActions.map(({ id, status }) => [id, status]),
      [['POINT-ACTION-1', 'processed'], ['POINT-ACTION-2', 'created']])
  }
  assert.equal(prints.length, 2)
  assert.equal(prints[1].key, reprintKey)
  assert.equal(prints[1].body.content, prints[0].body.content)
  assert.equal((await post(`/api/sales/${saleId}/refunds`, { amount: 3900 }, randomUUID())).status, 409)

  const register = await post('/api/register-sessions', { openingCash: 1000 }).then(r => r.json())
  await db.query("UPDATE items SET name='Pan <prueba>',price=1500 WHERE id=$1", [item.id])
  const cashSale = await post('/api/sales/cash/local', { items: [{ itemId: item.id, quantity: 1 }], cashReceived: 1500 }, randomUUID())
  assert.equal(cashSale.status, 201)
  const physical = await request(`/api/register-sessions/${register.id}/closure`).then(r => r.json())
  assert.equal(physical.live.web, undefined)
  assert.equal(physical.live.net, 1500)
  const summaryPath = `/api/register-day-summary?date=${day}`
  const daily = await request(summaryPath).then(r => r.json())
  assert.equal(daily.web.net, 3900)
  assert.equal(daily.cash.net, 1500)
  assert.equal(daily.card.net, 0)
  assert.equal(daily.net, 5400)
  assert.deepEqual(daily.registers.open.map(s => s.id), [register.id])
  assert.equal(daily.registers.closed, 0)
  const sessionPath = `/api/register-sessions/${register.id}/closure`
  const closed = await post(sessionPath, { countedCash: 2500, cashIn: 0, cashOut: 0,
    expectedRevision: 0, fingerprint: physical.live.fingerprint })
  const saved = await closed.json()
  assert.equal(closed.status, 200, JSON.stringify(saved))
  assert.equal(saved.expectedCash, 2500)
  assert.equal(saved.difference, 0)
  const afterClose = await request(summaryPath).then(r => r.json())
  assert.deepEqual(afterClose.registers, { open: [], closed: 1 })
  assert.equal(afterClose.net, daily.net)
  const response = await request(`/api/register-day-summary/${day}/pdf`)
  assert.equal(response.status, 200)
  const pdf = await PDFDocument.load(await response.arrayBuffer())
  const pdfText = pdf.getPages().flatMap(page => page.node.Contents().asArray()).flatMap(ref =>
    [...inflateSync(pdf.context.lookup(ref).getContents()).toString('latin1').matchAll(/<([a-fA-F0-9]+)>\s*Tj/g)]
      .map(match => Buffer.from(match[1], 'hex').toString('latin1'))).join('\n')
  assert.match(pdfText, /Web \(1\)/)
  assert.match(pdfText, /RESUMEN DEL DÍA/)
  assert.doesNotMatch(pdfText, /ARQUEO EFECTIVO|Efectivo contado/)
  for (const amount of ['$3.900', '$900', '$1.500', '$5.400']) assert.ok(pdfText.includes(amount), amount)

  const legacyIntegration = await post('/api/integration-clients', { name: 'Checkout anterior', expiresInDays: 30, reservationsEnabled: true })
  assert.equal(legacyIntegration.status, 201)
  token = (await legacyIntegration.json()).token
  const old = await reserve('checkout-legacy', '1.00')
  const oldPath = `/${old.id}/confirm`
  const reused = await change(oldPath, { ...old.body, paymentReference: body.paymentReference })
  assert.equal(reused.status, 409)
  assert.equal((await reused.json()).error.code, 'PAYMENT_ALREADY_USED')
  const oldKey = randomUUID()
  rejectPrint = true
  const legacy = await change(oldPath, old.body, oldKey).then(r => r.json())
  assert.match(legacy.saleId, /^[0-9a-f-]{36}$/)
  assert.equal((await request(`/api/sales/${legacy.saleId}`).then(r => r.json())).web.chargedTotal, null)
  await waitForPrint(legacy.saleId, 'failed')
  assert.equal(legacy.status, 'confirmed')
  const enriched = await change(oldPath, { ...old.body, paymentDetails: { ...details, orderReference: 'ORD-test-102',
    paymentId: 'PAY-test-102', shippingAmount: 0, chargedTotal: 1500 } }).then(r => r.json())
  assert.equal(enriched.saleId, legacy.saleId)
  assert.equal((await change(oldPath, old.body, oldKey).then(r => r.json())).saleId, legacy.saleId)
  assert.equal(prints.length, 3)
  const updated = await request(summaryPath).then(r => r.json())
  assert.equal(updated.web.net, 5400, 'Later web sales update the daily totals after the physical close')
  assert.equal(updated.net, 6900)
  const sessionAfterWeb = await request(sessionPath).then(r => r.json())
  assert.equal(sessionAfterWeb.closure.expectedCash, 2500)
  assert.equal(sessionAfterWeb.closure.revision, 1)
  assert.equal(sessionAfterWeb.live.net, 1500)

  const legacyState = { status: 'submitted', requestId: legacy.saleId }
  await db.query('UPDATE sales SET web_print=$2 WHERE id=$1', [legacy.saleId, legacyState])
  const lookupsBeforeLegacy = actionLookups.length
  const historical = await request(`/api/sales/${legacy.saleId}?refresh=true`).then(r => r.json())
  assert.equal(historical.webPrintStatus, 'submitted')
  assert.deepEqual(historical.webPrintActions, [])
  assert.equal(actionLookups.length, lookupsBeforeLegacy, 'Old submissions without an action ID do not query Point')

  // Model an oversized receipt in the disposable database to exercise a failure after its first part.
  await db.query(`
    INSERT INTO sale_items(id,sale_id,item_id,item_name,unit,quantity,unit_price,line_total)
    SELECT gen_random_uuid(),$1,$2,'Producto largo ' || n || repeat(' detalle',15),'pieces',1,1500,1500
    FROM generate_series(1,40) AS n
  `, [saleId, item.id])
  rejectPrint = false
  const multipartKey = randomUUID()
  const partial = await post(printPath, undefined, multipartKey).then(r => r.json())
  assert.equal(partial.pointPrint, 'uncertain')
  assert.deepEqual(partial.webPrintActions.map(action => action.id), ['POINT-ACTION-1', 'POINT-ACTION-2', 'POINT-ACTION-4'])
  const [firstPart] = partial.webPrintActions.filter(action => action.requestId === multipartKey)
  assert.equal(firstPart.part, 1)
  assert.ok(firstPart.parts > 1)
  assert.equal(prints.at(-1).key, multipartKey + '-2')
  assert.deepEqual((await readSale()).webPrintActions, partial.webPrintActions)
})
