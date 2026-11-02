import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

function preserveEnvironment(names) {
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address()))
  })
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

test('Point adapter follows the documented Orders API contract', async () => {
  const restoreEnvironment = preserveEnvironment([
    'MERCADOPAGO_API_BASE',
    'MERCADOPAGO_MOCK',
    'MERCADOPAGO_ACCESS_TOKEN',
    'MERCADOPAGO_POINT_TERMINAL_ID',
    'MERCADOPAGO_WEBHOOK_SECRET',
    'MERCADOPAGO_CASH_ENABLED',
    'MERCADOPAGO_CASH_TAX_CONDITION',
  ])
  const terminalId = 'NEWLAND_N950__SBX0000001'
  const requests = []
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const bodyText = Buffer.concat(chunks).toString('utf8')
    const body = bodyText ? JSON.parse(bodyText) : null
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      idempotencyKey: request.headers['x-idempotency-key'],
      body,
    })

    response.setHeader('Content-Type', 'application/json')
    if (request.method === 'GET' && request.url === '/terminals/v1/list?limit=50&offset=0') {
      return response.end(JSON.stringify({
        data: { terminals: [{ id: terminalId, operating_mode: 'PDV', store_id: 'STORE-1', pos_id: 42 }] },
      }))
    }
    if (request.method === 'POST' && request.url === '/v1/orders') {
      response.statusCode = 201
      return response.end(JSON.stringify({
        id: 'ORD-MOCK-1', type: 'point', external_reference: body?.external_reference,
        status: 'created', status_detail: 'created', transactions: { payments: [{ id: 'PAY-MOCK-1', status: 'created' }] },
      }))
    }
    if (request.method === 'GET' && request.url === '/v1/orders/ORD-MOCK-1') {
      return response.end(JSON.stringify({
        id: 'ORD-MOCK-1', type: 'point', external_reference: 'sale-sale-uuid-1',
        status: 'processed', status_detail: 'accredited', transactions: { payments: [{ id: 'PAY-MOCK-1', status: 'processed', status_detail: 'accredited' }] },
      }))
    }
    if (request.method === 'GET' && request.url === '/v1/payments/172570565606') {
      return response.end(JSON.stringify({
        id: 172570565606, authorization_code: '253893', payment_method_id: 'master',
        payment_type_id: 'prepaid_card', card: { last_four_digits: '1249' },
        fee_details: [{ type: 'mercadopago_fee', amount: 21 }],
        transaction_details: { net_received_amount: 979 },
        additional_info: { tax_setting: 'CHARGE_TAXABLE_19' },
      }))
    }
    if (request.method === 'POST' && request.url === '/v1/orders/ORD-MOCK-1/cancel') {
      return response.end(JSON.stringify({
        id: 'ORD-MOCK-1', type: 'point', external_reference: 'sale-sale-uuid-1',
        status: 'canceled', status_detail: 'canceled', transactions: { payments: [{ id: 'PAY-MOCK-1', status: 'canceled' }] },
      }))
    }
    if (request.method === 'POST' && request.url === '/v1/orders/ORD-MOCK-1/refund') {
      response.statusCode = 201
      return response.end(JSON.stringify({
        id: 'ORD-MOCK-1', type: 'point', external_reference: 'sale-sale-uuid-1',
        status: 'processed', status_detail: 'partially_refunded',
        transactions: {
          payments: [{ id: 'PAY-MOCK-1', status: 'processed', status_detail: 'partially_refunded' }],
          refunds: [{ id: 'REFUND-MOCK-1', amount: body?.transactions?.[0]?.amount, status: 'processed' }],
        },
      }))
    }
    if (request.method === 'POST' && request.url === '/terminals/v1/actions') {
      response.statusCode = 201
      return response.end(JSON.stringify({
        id: 'PRINT-ACTION-1', type: 'print', external_reference: body?.external_reference, status: 'created',
      }))
    }
    if (request.method === 'GET' && request.url === '/terminals/v1/actions/PRINT-ACTION-1') {
      return response.end(JSON.stringify({
        id: 'PRINT-ACTION-1', type: 'print', external_reference: 'PILOT-SALE0001', status: 'processed',
      }))
    }
    response.statusCode = 404
    response.end(JSON.stringify({ error: 'unexpected_request' }))
  })

  try {
    const address = await listen(server)
    process.env.MERCADOPAGO_API_BASE = `http://127.0.0.1:${address.port}`
    process.env.MERCADOPAGO_MOCK = 'false'
    process.env.MERCADOPAGO_ACCESS_TOKEN = 'test-access-token'
    process.env.MERCADOPAGO_POINT_TERMINAL_ID = terminalId
    process.env.MERCADOPAGO_WEBHOOK_SECRET = 'test-webhook-secret'
    delete process.env.MERCADOPAGO_CASH_ENABLED
    delete process.env.MERCADOPAGO_CASH_TAX_CONDITION
    const point = await import(`./mercadopago.js?contract=${Date.now()}`)
    const sale = { id: 'sale-uuid-1', shortId: 'SALE0001', mpExternalReference: 'VENTA-SALE0001', total: 4850, createdAt: new Date().toISOString() }

    assert.deepEqual(point.pointConfiguration(), {
      configured: true,
      mockMode: false,
      cashEnabled: false,
      cashTaxCondition: 'payment_taxable_iva',
      terminalConfigured: true,
      credentialsCentralized: true,
      credentialStorage: 'server_environment',
      credentialsExposedToClient: false,
      accessTokenTransport: 'authorization_header',
      webhookConfigured: true,
      webhookMode: 'application_order_topic',
      webhookTopic: 'order',
      webhookEndpointPath: '/api/mercadopago/webhook',
      webhookSignatureValidation: true,
      webhookAuthoritativeOrderLookup: true,
      terminalLabel: 'X0000001',
    })
    assert.doesNotMatch(JSON.stringify(point.pointConfiguration()), /test-access-token|test-webhook-secret/)

    assert.deepEqual(await point.getConfiguredTerminal(), {
      id: terminalId,
      label: 'X0000001',
      operatingMode: 'PDV',
      connected: true,
      online: null,
      ready: true,
      storeId: 'STORE-1',
      posId: 42,
    })

    const management = point.buildPointManagement({
      account: { id: 123, nickname: 'ATELIER', site_id: 'MLC' },
      stores: [{ id: 'STORE-1', name: 'Atelier del Puerto', external_id: 'ATELIER01' }],
      registers: [{ id: 42, name: 'Caja Atelier', external_id: 'CAJA01', store_id: 'STORE-1' }],
      terminals: [{ id: terminalId, operating_mode: 'PDV', store_id: 'STORE-1', pos_id: 42 }],
    })
    assert.equal(management.terminals[0].online, null)
    assert.equal(management.terminals[0].ready, true)
    assert.equal(management.terminals[0].store.name, 'Atelier del Puerto')
    assert.equal(management.terminals[0].register.name, 'Caja Atelier')
    assert.match(management.terminals[0].management_url, /SBX0000001$/)
    assert.equal(management.stores[0].assigned, true)
    assert.equal(management.stores[0].register_count, 1)
    assert.equal(management.registers[0].assigned, true)
    assert.equal(management.configuration.credentialsCentralized, true)
    assert.equal(management.configuration.credentialsExposedToClient, false)
    assert.equal(management.configuration.accessTokenTransport, 'authorization_header')
    assert.equal(management.configuration.webhookMode, 'application_order_topic')
    assert.equal(management.configuration.webhookTopic, 'order')
    assert.equal(management.configuration.webhookAuthoritativeOrderLookup, true)
    assert.doesNotMatch(JSON.stringify(management), /test-access-token|test-webhook-secret/)

    const created = await point.createPointOrder(sale)
    assert.equal(created.status, 'created')
    assert.equal((await point.getPointOrder(created.id, sale)).status, 'processed')
    assert.equal((await point.getPointPayment('172570565606')).authorization_code, '253893')
    assert.equal((await point.cancelPointOrder(created.id, sale)).status, 'canceled')
    const refunded = await point.refundPointOrder(created.id, { ...sale, mpPaymentId: 'PAY-MOCK-1' }, {
      id: 'refund-uuid-1', amount: 1850, full: false,
    })
    assert.equal(refunded.status_detail, 'partially_refunded')
    const printed = await point.printPointRefundCopy({
      ...sale,
      paymentMethod: 'card',
      mpPaymentId: 'PAY-MOCK-1',
      mpOperationId: '172570565606',
      mpCardBrand: 'master',
      mpCardLastFour: '1249',
    }, {
      id: 'refund-uuid-1', status: 'processed', amount: 1850,
      mpRefundId: 'REFUND-MOCK-1', processedAt: '2026-08-11T14:30:00.000Z',
    })
    assert.equal(printed.id, 'PRINT-ACTION-1')
    assert.deepEqual(requests.map(({ method, url }) => ({ method, url })), [
      { method: 'GET', url: '/terminals/v1/list?limit=50&offset=0' },
      { method: 'POST', url: '/v1/orders' },
      { method: 'GET', url: '/v1/orders/ORD-MOCK-1' },
      { method: 'GET', url: '/v1/payments/172570565606' },
      { method: 'POST', url: '/v1/orders/ORD-MOCK-1/cancel' },
      { method: 'POST', url: '/v1/orders/ORD-MOCK-1/refund' },
      { method: 'POST', url: '/terminals/v1/actions' },
    ])
    assert.ok(requests.every((request) => request.authorization === 'Bearer test-access-token'))
    assert.equal(requests[1].idempotencyKey, sale.id)
    assert.equal(Object.hasOwn(requests[1].body, 'notification_url'), false)
    assert.match(requests[4].idempotencyKey, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i)
    assert.equal(requests[5].idempotencyKey, 'refund-uuid-1')
    assert.deepEqual(requests[5].body, { transactions: [{ id: 'PAY-MOCK-1', amount: '1850' }] })
    assert.match(requests[6].idempotencyKey, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i)
    assert.match(requests[6].body.external_reference, /^REFUND-SALE0001-refund-uuid-/)
    assert.equal(requests[6].body.type, 'print')
    assert.deepEqual(requests[6].body.config, { point: { terminal_id: terminalId, subtype: 'custom' } })
    assert.match(requests[6].body.content, /COPIA DE DEVOLUCION/)
    assert.match(requests[6].body.content, /NO TRIBUTARIO/)
    assert.match(requests[6].body.content, /REFUND-MOCK-1/)
    assert.doesNotMatch(requests[6].body.content, /[^\x00-\x7F]/)
    assert.deepEqual(requests[1].body, {
      type: 'point',
      external_reference: sale.mpExternalReference,
      expiration_time: 'PT10M',
      description: `Bakery sale ${sale.shortId}`,
      transactions: { payments: [{ amount: '4850' }] },
      config: { point: { terminal_id: terminalId, print_on_terminal: 'seller_ticket' } },
    })
  } finally {
    if (server.listening) await close(server)
    restoreEnvironment()
  }
})

test('built-in Point mock simulates terminal arrival, approval, and cancellation', async () => {
  const restoreEnvironment = preserveEnvironment([
    'MERCADOPAGO_MOCK',
    'MERCADOPAGO_ACCESS_TOKEN',
    'MERCADOPAGO_POINT_TERMINAL_ID',
    'MERCADOPAGO_WEBHOOK_SECRET',
  ])
  try {
    process.env.MERCADOPAGO_MOCK = 'true'
    delete process.env.MERCADOPAGO_ACCESS_TOKEN
    delete process.env.MERCADOPAGO_POINT_TERMINAL_ID
    delete process.env.MERCADOPAGO_WEBHOOK_SECRET
    const point = await import(`./mercadopago.js?mock=${Date.now()}`)
    const sale = { id: 'mock-sale-1', shortId: 'MOCK0001', total: 3200, createdAt: new Date().toISOString() }

    assert.equal(point.pointConfiguration().configured, true)
    assert.deepEqual(await point.getConfiguredTerminal(), {
      id: 'MOCK_POINT_SMART_2', operatingMode: 'PDV', connected: true, online: true, ready: true,
    })
    assert.equal((await point.createPointOrder(sale)).status, 'created')
    const cash = { ...sale, paymentMethod: 'cash', createdAt: new Date(Date.now() - 2000).toISOString() }
    assert.deepEqual((await point.getPointOrder(`MOCK-${cash.id}`, cash)).transactions.payments[0].payment_method, { id: 'cash', type: 'cash' })
    assert.equal((await point.getPointOrder('MOCK-mock-sale-1', sale)).status, 'at_terminal')

    const olderSale = { ...sale, createdAt: new Date(Date.now() - 1500).toISOString() }
    const processed = await point.getPointOrder('MOCK-mock-sale-1', olderSale)
    assert.equal(processed.status, 'processed')
    assert.equal(processed.status_detail, 'accredited')
    assert.equal(processed.transactions.payments[0].paid_amount, '3200')
    assert.equal((await point.cancelPointOrder('MOCK-mock-sale-1', sale)).status, 'canceled')
    await assert.rejects(
      point.cancelPointOrder('MOCK-mock-sale-1', { ...sale, mpStatus: 'at_terminal' }),
      (error) => error.status === 409 && error.code === 'POINT_CANCEL_ON_TERMINAL' && error.pointStatus === 'at_terminal',
    )
    const partialRefund = await point.refundPointOrder('MOCK-mock-sale-1', { ...sale, mpPaymentId: 'MOCK-PAY-mock-sale-1' }, {
      id: 'mock-refund-1', amount: 1200, full: false,
    })
    assert.equal(partialRefund.status_detail, 'partially_refunded')
    const fullRefund = await point.refundPointOrder('MOCK-mock-sale-1', { ...sale, mpPaymentId: 'MOCK-PAY-mock-sale-1' }, {
      id: 'mock-refund-2', amount: 3200, full: true,
    })
    assert.equal(fullRefund.status, 'refunded')
    const printed = await point.printPointRefundCopy({ ...sale, paymentMethod: 'card' }, {
      id: 'mock-refund-2', status: 'processed', amount: 3200,
    })
    assert.equal(printed.type, 'print')
    assert.equal(printed.status, 'processed')
  } finally {
    restoreEnvironment()
  }
})

test('Point infrastructure adapter manages stores, registers, and terminal modes', async () => {
  const restoreEnvironment = preserveEnvironment([
    'MERCADOPAGO_API_BASE', 'MERCADOPAGO_MOCK', 'MERCADOPAGO_ACCESS_TOKEN',
    'MERCADOPAGO_POINT_TERMINAL_ID', 'MERCADOPAGO_WEBHOOK_SECRET',
  ])
  const requests = []
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const bodyText = Buffer.concat(chunks).toString('utf8')
    requests.push({ method: request.method, url: request.url, body: bodyText ? JSON.parse(bodyText) : null })
    response.setHeader('Content-Type', 'application/json')
    if (request.method === 'GET' && request.url === '/users/me') return response.end(JSON.stringify({ id: 123, nickname: 'atelier', site_id: 'MLC' }))
    if (request.method === 'GET' && request.url.startsWith('/users/123/stores/search')) return response.end(JSON.stringify({ results: [{ id: 'STORE-1', name: 'Atelier del Puerto', external_id: 'ATELIER-01' }], paging: { total: 1 } }))
    if (request.method === 'POST' && request.url === '/users/123/stores') { response.statusCode = 201; return response.end(JSON.stringify({ id: 'STORE-2', ...requests.at(-1).body })) }
    if (request.method === 'PUT' && request.url === '/users/123/stores/STORE-1') return response.end(JSON.stringify({ id: 'STORE-1', ...requests.at(-1).body }))
    if (request.method === 'DELETE' && request.url === '/users/123/stores/STORE-1') return response.end(JSON.stringify({ id: 'STORE-1', deleted: true }))
    if (request.method === 'GET' && request.url.startsWith('/pos?')) return response.end(JSON.stringify({ results: [{ id: 'POS-1', name: 'Caja 1', store_id: 'STORE-1' }], paging: { total: 1 } }))
    if (request.method === 'POST' && request.url === '/pos') { response.statusCode = 201; return response.end(JSON.stringify({ id: 'POS-2', ...requests.at(-1).body })) }
    if (request.method === 'PUT' && request.url === '/pos/POS-1') return response.end(JSON.stringify({ id: 'POS-1', ...requests.at(-1).body }))
    if (request.method === 'DELETE' && request.url === '/pos/POS-1') return response.end(JSON.stringify({ id: 'POS-1', deleted: true }))
    if (request.method === 'GET' && request.url.startsWith('/terminals/v1/list?')) return response.end(JSON.stringify({ data: { terminals: [{ id: 'NEWLAND_N950__SERIAL', operating_mode: 'STANDALONE' }] }, paging: { total: 1 } }))
    if (request.method === 'PATCH' && request.url === '/terminals/v1/setup') return response.end(JSON.stringify(requests.at(-1).body))
    response.statusCode = 404
    response.end(JSON.stringify({ error: 'unexpected_request' }))
  })

  try {
    const address = await listen(server)
    process.env.MERCADOPAGO_API_BASE = `http://127.0.0.1:${address.port}`
    process.env.MERCADOPAGO_MOCK = 'false'
    process.env.MERCADOPAGO_ACCESS_TOKEN = 'admin-token'
    delete process.env.MERCADOPAGO_POINT_TERMINAL_ID
    const point = await import(`./mercadopago.js?management=${Date.now()}`)

    const stores = await point.listPointStores()
    const registers = await point.listPointPos({ storeId: 'STORE-1' })
    const terminals = await point.listPointTerminals({ storeId: 'STORE-1', posId: 'POS-1' })
    assert.equal(stores.stores[0].name, 'Atelier del Puerto')
    assert.equal(registers.registers[0].id, 'POS-1')
    assert.equal(terminals.terminals[0].operating_mode, 'STANDALONE')
    assert.equal((await point.createPointStore({ name: 'Nueva sucursal', external_id: 'NEW-1', location: { city_name: 'Viña del Mar' } })).id, 'STORE-2')
    assert.equal((await point.createPointPos({ name: 'Caja 2', store_id: 'STORE-1', fixed_amount: false })).id, 'POS-2')
    assert.equal((await point.updatePointStore('STORE-1', { name: 'Atelier actualizado' })).name, 'Atelier actualizado')
    assert.equal((await point.updatePointPos('POS-1', { name: 'Caja actualizada' })).name, 'Caja actualizada')
    assert.equal((await point.deletePointStore('STORE-1')).deleted, true)
    assert.equal((await point.deletePointPos('POS-1')).deleted, true)
    assert.equal((await point.setupPointTerminal('NEWLAND_N950__SERIAL', 'PDV')).terminals[0].operating_mode, 'PDV')
    assert.ok(requests.every((request) => ['GET', 'DELETE'].includes(request.method) || request.body !== null))
  } finally {
    if (server.listening) await close(server)
    restoreEnvironment()
  }
})

test('Point writes preserve uncertainty and idempotency until the provider confirms their outcome', async () => {
  const restoreEnvironment = preserveEnvironment([
    'MERCADOPAGO_API_BASE', 'MERCADOPAGO_MOCK', 'MERCADOPAGO_ACCESS_TOKEN', 'MERCADOPAGO_POINT_TERMINAL_ID',
  ])
  const requests = []
  let outcome
  const server = http.createServer(async (request, response) => {
    for await (const chunk of request) {} // Drain the local fixture's request.
    requests.push({ method: request.method, key: request.headers['x-idempotency-key'] })
    response.writeHead(outcome.status || 200, {
      'Content-Type': 'application/json', ...(outcome.truncated ? { 'Content-Length': 4096 } : {}),
    })
    if (outcome.truncated) {
      response.flushHeaders()
      response.write('{"id":')
      return setImmediate(() => response.destroy())
    }
    response.end(typeof outcome.body === 'string' ? outcome.body : JSON.stringify(outcome.body))
  })
  try {
    const address = await listen(server)
    process.env.MERCADOPAGO_API_BASE = `http://127.0.0.1:${address.port}`
    process.env.MERCADOPAGO_MOCK = 'false'
    process.env.MERCADOPAGO_ACCESS_TOKEN = 'local-fixture-token'
    process.env.MERCADOPAGO_POINT_TERMINAL_ID = 'LOCAL-TERMINAL'
    const point = await import(`./mercadopago.js?recovery=${Date.now()}`)
    const sale = { id: 'stable-sale-key', shortId: 'SALEKEY', total: 1000, mpPaymentId: 'PAY-1' }
    const refund = { id: 'stable-refund-key', amount: 500, full: false }
    const operations = [() => point.createPointOrder(sale), () => point.refundPointOrder('ORDER-1', sale, refund)]
    const uncertain = (error) => error.uncertain === true && error.status >= 500
    for (const status of [500, 502, 503, 504]) {
      outcome = { status, body: { message: 'Local provider accepted the operation but could not confirm it.' } }
      for (const operation of operations) await assert.rejects(operation(), (error) => uncertain(error) && error.mercadoPagoStatus === status)
    }
    for (const status of [400, 401, 403, 409, 422, 429]) {
      outcome = { status, body: { message: 'Local deterministic rejection', code: 'rejected' } }
      for (const operation of operations) await assert.rejects(operation(), (error) => !error.uncertain && error.mercadoPagoStatus === status && error.mercadoPagoCode === 'rejected')
    }
    // A non-JSON rejection is still a rejection; its HTTP status is authoritative.
    outcome = { status: 400, body: '<html>rejected</html>' }
    await assert.rejects(operations[0](), (error) => !error.uncertain && error.mercadoPagoStatus === 400)
    for (const body of ['', '{', 'null', '[]', '{}', '{"id":"ORDER-1","status":"unknown"}']) {
      outcome = { status: 201, body }
      for (const operation of operations) await assert.rejects(operation(), uncertain)
    }
    outcome = { status: 201, truncated: true }
    for (const operation of operations) await assert.rejects(operation(), uncertain)
    for (const confirmation of [
      { id: 'REF-1', amount: '500', status: 'processing' },
      { id: 'REF-1', amount: '600', status: 'processed' },
      { id: 'REF-1', amount: '500', status: 'processed', transaction_id: 'OTHER-PAYMENT' },
    ]) {
      outcome = { body: { id: 'ORDER-1', status: 'processed', transactions: { refunds: [confirmation] } } }
      await assert.rejects(operations[1](), uncertain)
    }
    outcome = { body: { id: 'ORDER-1', status: 'created', external_reference: 'ANOTHER-SALE' } }
    await assert.rejects(operations[0](), uncertain)
    outcome = { body: { id: 'ORDER-1', status: 'created' } }
    assert.equal((await operations[0]()).id, 'ORDER-1')
    outcome = { body: { id: 'ORDER-1', status: 'processed', transactions: { refunds: [{ id: 'REF-1', amount: '500', status: 'processed' }] } } }
    assert.equal((await operations[1]()).transactions.refunds[0].id, 'REF-1')
    assert.ok(requests.every((request) => [sale.id, refund.id].includes(request.key)))

    const acceptedRefund = { ...refund, mpRefundId: 'REF-1' }
    const readsStartedAt = requests.length
    for (const body of [
      { id: 'ORDER-1', status: 'processed', transactions: { refunds: [{ id: 'OTHER-REFUND', amount: '500', status: 'processed' }] } },
      { id: 'ORDER-1', status: 'processed', transactions: { refunds: [{ id: 'REF-1', amount: '500', status: 'processing' }] } },
    ]) {
      outcome = { body }
      await assert.rejects(point.refundPointOrder('ORDER-1', sale, acceptedRefund), (error) => uncertain(error) && error.pointRefundId === acceptedRefund.mpRefundId)
    }
    outcome = { status: 503, body: { message: 'Refund read unavailable' } }
    await assert.rejects(point.refundPointOrder('ORDER-1', sale, acceptedRefund), (error) => uncertain(error) && error.pointRefundId === acceptedRefund.mpRefundId)
    outcome = { body: { id: 'ORDER-1', status: 'processed', transactions: { refunds: [
      { id: 'REF-1', amount: '500', status: 'processed' },
      { id: 'OTHER-REFUND', amount: '500', status: 'processed' },
    ] } } }
    const confirmed = await point.refundPointOrder('ORDER-1', sale, acceptedRefund)
    assert.deepEqual(confirmed.transactions.refunds, [{ id: 'REF-1', amount: '500', status: 'processed' }])
    assert.ok(requests.slice(readsStartedAt).every((request) => request.method === 'GET' && !request.key), 'Known provider refunds must be polled, never resubmitted')

    for (const invalid of [
      { status: 503, body: { message: 'Read unavailable' } },
      { body: 'null' }, { body: '{}' }, { body: '{' }, { truncated: true },
      { body: { id: 'OTHER-ORDER', status: 'failed' } },
      { body: { id: 'ORDER-1', status: 'unknown' } },
    ]) {
      outcome = invalid
      await assert.rejects(point.getPointOrder('ORDER-1', sale), (error) => error.status >= 500 && !error.uncertain)
    }
    await close(server)
    for (const operation of operations) await assert.rejects(operation(), uncertain)
    await assert.rejects(point.getPointOrder('ORDER-1', sale), (error) => error.status === 502 && !error.uncertain)
  } finally {
    if (server.listening) await close(server)
    restoreEnvironment()
  }
})
