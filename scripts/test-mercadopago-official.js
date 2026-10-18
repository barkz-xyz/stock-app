const baseUrl = process.env.MP_TEST_BASE_URL || 'https://stock-app-production-c80c.up.railway.app'
const apiBase = process.env.MERCADOPAGO_API_BASE || 'https://api.mercadopago.com'
const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN || ''
const terminalId = process.env.MERCADOPAGO_POINT_TERMINAL_ID || ''
const staffPin = process.env.APP_PASSWORD || process.env.STAFF_PIN || ''

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

assert(process.env.CONFIRM_MP_OFFICIAL_TEST === 'true', 'Set CONFIRM_MP_OFFICIAL_TEST=true to acknowledge an official sandbox run.')
assert(process.env.MERCADOPAGO_MOCK === 'false', 'MERCADOPAGO_MOCK must be false.')
assert(terminalId === 'NEWLAND_N950__SBX0000001', 'Refusing to run without Mercado Pago standard virtual terminal SBX0000001.')
assert(apiBase === 'https://api.mercadopago.com', 'Refusing to run against a non-official Mercado Pago API base.')
assert(accessToken, 'MERCADOPAGO_ACCESS_TOKEN is missing.')
assert(staffPin, 'APP_PASSWORD is missing.')

async function parseResponse(response) {
  const text = await response.text()
  const data = text ? JSON.parse(text) : null
  if (!response.ok) {
    const detail = data?.error || data?.message || `HTTP ${response.status}`
    throw new Error(detail)
  }
  return data
}

const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username:process.env.APP_USERNAME||'admin',password:staffPin }),
})
await parseResponse(loginResponse)
const cookie = loginResponse.headers.get('set-cookie')?.split(';')[0]
assert(cookie, 'The Railway app did not issue an authenticated staff session.')

async function appRequest(path, { method = 'GET', body } = {}) {
  return parseResponse(await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }))
}

async function quantityFor(itemId) {
  const items = await appRequest('/api/items')
  return Number(items.find((item) => item.id === itemId)?.quantity)
}

async function ensureTestProduct() {
  const items = await appRequest('/api/items')
  let product = items.find((item) => item.sku === 'MP-SBX-TEST')
  if (!product) {
    product = await appRequest('/api/items', {
      method: 'POST',
      body: {
        name: '[SANDBOX] Mercado Pago test',
        category: 'Pastries',
        unit: 'pieces',
        quantity: 20,
        lowStockThreshold: 2,
        sku: 'MP-SBX-TEST',
        expiryDate: null,
        price: 1000,
        sellable: true,
      },
    })
  } else if (Number(product.quantity) < 10) {
    product = await appRequest(`/api/items/${encodeURIComponent(product.id)}/adjust`, {
      method: 'POST',
      body: { type: 'stock_in', quantity: 20 - Number(product.quantity), note: 'Official Mercado Pago sandbox test stock' },
    })
  }
  return product
}

async function simulate(orderId, body) {
  const response = await fetch(`${apiBase}/v1/orders/${encodeURIComponent(orderId)}/events`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (response.status !== 204) {
    const text = await response.text()
    let detail = text
    try { detail = JSON.parse(text)?.message || JSON.parse(text)?.error || text } catch {}
    throw new Error(`Mercado Pago simulation returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
  }
}

async function waitForWebhook(saleId, expectedStatus, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const sale = await appRequest(`/api/sales/${encodeURIComponent(saleId)}`)
    if (sale.status === expectedStatus) return sale
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  const refreshed = await appRequest(`/api/sales/${encodeURIComponent(saleId)}?refresh=true`)
  throw new Error(`Webhook did not set sale ${saleId} to ${expectedStatus} within ${timeoutMs / 1000}s; direct refresh returned ${refreshed.status}.`)
}

async function runScenario(product, scenario) {
  const before = await quantityFor(product.id)
  const sale = await appRequest('/api/sales/card', {
    method: 'POST',
    body: { items: [{ itemId: product.id, quantity: 1 }] },
  })
  assert(sale.status === 'pending', `${scenario.name}: new card sale was not pending.`)
  assert(String(sale.mpOrderId || '').startsWith('ORD'), `${scenario.name}: Mercado Pago did not return an official order ID.`)
  assert(await quantityFor(product.id) === before - 1, `${scenario.name}: stock was not reserved exactly once.`)

  await simulate(sale.mpOrderId, scenario.simulation)
  const finalSale = await waitForWebhook(sale.id, scenario.expectedStatus)
  const after = await quantityFor(product.id)
  const expectedQuantity = scenario.restoresStock ? before : before - 1
  assert(after === expectedQuantity, `${scenario.name}: expected stock ${expectedQuantity}, received ${after}.`)

  return {
    scenario: scenario.name,
    sale: finalSale.shortId,
    order: finalSale.mpOrderId,
    status: finalSale.status,
    mercadoPagoStatus: finalSale.mpStatus,
    mercadoPagoStatusDetail: finalSale.mpStatusDetail,
    stockBefore: before,
    stockAfter: after,
    webhookReconciled: true,
  }
}

const configuration = await appRequest('/api/pos/config')
assert(configuration.configured === true, 'Railway reports that Point is not configured.')
assert(configuration.mockMode === false, 'Railway is unexpectedly using the internal Point mock.')

const product = await ensureTestProduct()
const scenarios = [
  {
    name: 'processed', expectedStatus: 'paid', restoresStock: false,
    simulation: {
      status: 'processed', payment_method_type: 'credit_card', installments: 1,
      payment_method_id: 'visa', status_detail: 'accredited',
    },
  },
  {
    name: 'failed', expectedStatus: 'failed', restoresStock: true,
    simulation: {
      status: 'failed', payment_method_type: 'credit_card', installments: 1,
      payment_method_id: 'visa', status_detail: 'insufficient_amount',
    },
  },
  { name: 'canceled', expectedStatus: 'cancelled', restoresStock: true, simulation: { status: 'canceled' } },
  { name: 'expired', expectedStatus: 'expired', restoresStock: true, simulation: { status: 'expired' } },
]

const results = []
for (const scenario of scenarios) results.push(await runScenario(product, scenario))

console.log(JSON.stringify({
  ok: true,
  environment: 'Railway production with disposable test data',
  terminal: 'NEWLAND_N950__SBX0000001',
  scenarios: results,
}, null, 2))
