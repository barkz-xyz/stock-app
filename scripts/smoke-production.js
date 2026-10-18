import assert from 'node:assert/strict'

const base = process.env.PRODUCTION_BASE_URL || 'https://stock-app-production-c80c.up.railway.app'
const pin = process.env.APP_PASSWORD || process.env.STAFF_PIN
if (!pin) throw new Error('APP_PASSWORD is required for authenticated read-only production checks.')
const results = []
async function read(route, cookie) {
  const response = await fetch(`${base}${route}`, { headers: cookie ? { Cookie: cookie } : {}, signal: AbortSignal.timeout(20000) })
  results.push({ route, status: response.status })
  assert.equal(response.status, 200, route)
  return response.json()
}
assert.equal((await read('/api/health')).ok, true)
const auth = await read('/api/auth/status')
assert.equal(auth.required, true)
assert.equal(auth.productionReady, true)
const blocked = await fetch(`${base}/api/items`, { signal: AbortSignal.timeout(20000) })
assert.equal(blocked.status, 401)
results.push({ route: '/api/items (unauthenticated)', status: blocked.status })
const malformed = await fetch(`${base}/api/items`, { headers: { Cookie: 'bakery_session=%' }, signal: AbortSignal.timeout(20000) })
results.push({ route: '/api/items (malformed cookie)', status: malformed.status })
if (process.env.EXPECT_AUTH_HARDENING === 'true') assert.equal(malformed.status, 401)
const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username:process.env.APP_USERNAME||'admin',password:pin }), signal: AbortSignal.timeout(20000) })
assert.equal(login.status, 200)
const cookie = login.headers.get('set-cookie')?.split(';')[0]
assert.ok(cookie)
assert.ok(/;\s*Secure/i.test(login.headers.get('set-cookie')))
const items = await read('/api/items', cookie)
const sales = await read('/api/sales', cookie)
const config = await read('/api/pos/config', cookie)
assert.equal(config.credentialsExposedToClient, false)
assert.equal(config.webhookConfigured, true)
assert.equal(config.mockMode, false)
const terminal = await read('/api/pos/terminal', cookie)
console.log(JSON.stringify({ results, productCount: items.length, returnedSales: sales.length,
  point: { configured: config.configured, webhookConfigured: config.webhookConfigured, mockMode: config.mockMode,
    terminalMode: terminal.operating_mode || terminal.operatingMode || terminal.mode } }, null, 2))
