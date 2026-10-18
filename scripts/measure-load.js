// Read-only HTTP measurements. Supply STAFF_PIN for a protected deployment.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { metricsPeriod } from '../src/api.js'

const base = process.env.PRODUCTION_BASE_URL || 'http://localhost:3000'
const output = process.env.PERFORMANCE_OUTPUT || 'output/performance.json'
const legacy = process.argv.includes('--legacy')
let cookie = ''
async function read(route) {
  const started = performance.now()
  const response = await fetch(base + route, { headers: cookie ? { Cookie: cookie } : {}, signal: AbortSignal.timeout(20000) })
  const headersMs = performance.now() - started
  const body = await response.text()
  assert.equal(response.status, 200, route)
  return { route, headersMs, totalMs: performance.now() - started, bytes: Buffer.byteLength(body), gzipBytes: gzipSync(body).length, etag: response.headers.get('etag'), serverTiming: response.headers.get('server-timing'), data: JSON.parse(body) }
}
const status = (await read('/api/auth/status')).data
if (status.required) {
  assert.ok(process.env.STAFF_PIN, 'STAFF_PIN is required for authenticated measurements')
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: process.env.STAFF_PIN }), signal: AbortSignal.timeout(20000) })
  assert.equal(login.status, 200, 'Staff login')
  cookie = login.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  await login.arrayBuffer()
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const summarize = samples => ({ samples: samples.length, medianMs: Math.round(median(samples) * 10) / 10, minMs: Math.round(Math.min(...samples) * 10) / 10, maxMs: Math.round(Math.max(...samples) * 10) / 10 })
const routes = ['/api/items', '/api/movements?limit=100', '/api/sales?limit=50', '/api/pos/config', `/api/metrics?${new URLSearchParams(metricsPeriod('30d'))}`]
const endpoints = []
for (const route of routes) {
  const samples = []
  for (let index = 0; index < 5; index++) samples.push(await read(route))
  endpoints.push({ route: route.split('?')[0], ...summarize(samples.map(sample => sample.totalMs)), bytes: samples[0].bytes, gzipBytes: samples[0].gzipBytes, serverTiming: samples.at(-1).serverTiming })
}
const startup = []
let startupBytes = 0
for (let index = 0; index < 5; index++) {
  const started = performance.now()
  if (legacy) {
    const auth = await read('/api/auth/status')
    const responses = await Promise.all(routes.slice(0, 4).map(read))
    startupBytes = auth.gzipBytes + responses.reduce((sum, response) => sum + response.gzipBytes, 0)
  } else {
    const response = await read('/api/bootstrap')
    assert.equal(response.data.auth.authenticated, true)
    startupBytes = response.gzipBytes
  }
  startup.push(performance.now() - started)
}
const html = await fs.readFile('dist/index.html', 'utf8')
const entry = html.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1]
const entryBody = await fs.readFile('dist' + entry)
const initialFiles = [entry, ...[...html.matchAll(/rel="modulepreload"[^>]*href="([^"]+)"/g)].map(match => match[1])]
const initialBodies = await Promise.all(initialFiles.map(file => fs.readFile('dist' + file)))
let conditionalPolling = null
if (!legacy) {
  const history = await read('/api/sales?limit=50')
  const response = await fetch(base + '/api/sales?limit=50', { cache: 'no-cache', headers: { ...(cookie ? { Cookie: cookie } : {}), 'If-None-Match': history.etag }, signal: AbortSignal.timeout(20000) })
  conditionalPolling = { status: response.status, bytes: (await response.arrayBuffer()).byteLength, previousGzipBytes: history.gzipBytes }
}
const report = { base, mode: legacy ? 'legacy' : 'bootstrap', startup: { ...summarize(startup), requests: legacy ? 5 : 1, gzipBytes: startupBytes }, endpoints, conditionalPolling, entry: { file: entry, bytes: entryBody.length, gzipBytes: gzipSync(entryBody).length }, initialJavascript: { files: initialFiles, bytes: initialBodies.reduce((sum, body) => sum + body.length, 0), gzipBytes: initialBodies.reduce((sum, body) => sum + gzipSync(body).length, 0) } }
await fs.mkdir(path.dirname(output), { recursive: true })
await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
