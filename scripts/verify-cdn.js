// Read-only CDN delivery/freshness checks. Run from the repository after building.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const base = process.env.PRODUCTION_BASE_URL || 'https://stock-app-production-c80c.up.railway.app'
const baseline = process.argv.includes('--baseline')
const output = process.env.CDN_OUTPUT || `output/cdn-${baseline ? 'before' : 'after'}.json`
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const html = await fs.readFile('dist/index.html', 'utf8')
const assetNames = await fs.readdir('dist/assets')
const entry = html.match(/src="(\/assets\/index-[^"]+\.js)"/)[1]
const routes = ['/', entry, ...['react-vendor-', 'index-', 'berlines-192-'].map(prefix => '/assets/' + assetNames.find(name => name.startsWith(prefix) && (prefix !== 'index-' || name.endsWith('.css'))))]
const headers = { 'X-Railway-Debug': '1' }
async function read(route, options = {}) {
  const started = performance.now()
  const response = await fetch(base + route, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(20000) })
  const headersMs = performance.now() - started
  const body = Buffer.from(await response.arrayBuffer())
  return { route, status: response.status, headersMs, totalMs: performance.now() - started, bytes: body.length,
    cache: response.headers.get('x-cache'), age: response.headers.get('age'), cacheControl: response.headers.get('cache-control'),
    vary: response.headers.get('vary'), encoding: response.headers.get('content-encoding'), edge: response.headers.get('x-railway-edge'), zone: response.headers.get('x-railway-upstream-zone'), body }
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const assets = []
for (const route of routes) {
  const expected = await fs.readFile(route === '/' ? 'dist/index.html' : 'dist' + route)
  const warmup = await read(route)
  assert.equal(warmup.status, 200, route)
  assert.equal(hash(warmup.body), hash(expected), `Deployed bytes match local build: ${route}`)
  const samples = []
  for (let index = 0; index < 5; index++) {
    const sample = await read(route)
    assert.equal(sample.status, 200, route)
    assert.equal(hash(sample.body), hash(expected), route)
    samples.push(sample)
  }
  if (!baseline) assert.ok(samples.some(sample => sample.cache === 'HIT'), `CDN cache hit: ${route}`)
  assets.push({ route, warmupCache: warmup.cache, medianHeadersMs: Math.round(median(samples.map(sample => sample.headersMs)) * 10) / 10,
    medianTotalMs: Math.round(median(samples.map(sample => sample.totalMs)) * 10) / 10, bytes: expected.length,
    cacheResults: samples.map(sample => sample.cache), cacheControl: samples.at(-1).cacheControl, encoding: samples.at(-1).encoding, edge: samples.at(-1).edge })
}
const api = []
async function privateRead(route, options) {
  const result = await read(route, options)
  assert.ok(!['HIT', 'STALE'].includes(result.cache), `Never share API response: ${route}`)
  if (!baseline) {
    assert.match(result.cacheControl, /private/)
    assert.match(result.vary, /Cookie/i)
  }
  const { body, ...metadata } = result
  api.push(metadata)
  return { ...metadata, data: JSON.parse(body.toString() || '{}') }
}
const status = await privateRead('/api/auth/status')
if (status.data.required) {
  const blocked = await privateRead('/api/items')
  assert.equal(blocked.status, 401)
  const locked = await privateRead('/api/bootstrap')
  assert.deepEqual(Object.keys(locked.data), ['auth'])
}
let inventory = null
if (process.env.STAFF_PIN) {
  // Obtain a fresh session without ever recording cookies or credentials in reports.
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: process.env.STAFF_PIN }), signal: AbortSignal.timeout(20000) })
  assert.equal(response.status, 200)
  assert.ok(!['HIT', 'STALE'].includes(response.headers.get('x-cache')))
  if (!baseline) assert.match(response.headers.get('cache-control'), /private, no-store/)
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  await response.arrayBuffer()
  const authHeaders = { Cookie: cookie }
  const boot = await privateRead('/api/bootstrap', { headers: authHeaders })
  assert.equal(boot.data.auth.authenticated, true)
  const history = await privateRead('/api/sales?limit=50', { headers: authHeaders })
  assert.equal(history.status, 200)
  const missing = await privateRead('/api/cdn-missing-route', { headers: authHeaders })
  assert.equal(missing.status, 404)
  const shell = await read('/', { headers: authHeaders })
  assert.equal(hash(shell.body), hash(Buffer.from(html)))
  if (!baseline) assert.equal(shell.cache, 'HIT', 'Shared shell contains no session data')
  inventory = { products: boot.data.items.length, recentSales: boot.data.sales.length, recentRefunds: boot.data.sales.reduce((count, sale) => count + sale.refunds.length, 0) }
}
const report = { base, phase: baseline ? 'before' : 'after', samplesPerAsset: 5, assets, api, inventory }
await fs.mkdir(path.dirname(output), { recursive: true })
await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ phase: report.phase, assets, api: api.map(({ route, status, cache, cacheControl }) => ({ route, status, cache, cacheControl })), inventory }, null, 2))
