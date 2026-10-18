import assert from 'node:assert/strict'
import test from 'node:test'

async function client(t, fetch) {
  const original = globalThis.fetch
  globalThis.fetch = fetch
  t.after(() => { globalThis.fetch = original })
  return (await import(`../src/api.js?test=${Math.random()}`)).api
}
const json = (data, etag) => new Response(JSON.stringify(data), { headers: etag ? { etag } : {} })

test('simultaneous initial reads share a request and failed reads can retry', async (t) => {
  let calls = 0
  let resolve
  const api = await client(t, async () => { calls += 1; return new Promise(done => { resolve = done }) })
  const first = api.bootstrap()
  const second = api.bootstrap()
  assert.equal(calls, 1)
  resolve(json({ auth: { authenticated: true } }))
  const results = await Promise.all([first, second])
  assert.equal(results[0], results[1])
  const failed = api.bootstrap()
  resolve(new Response('{"error":"Unavailable"}', { status: 503 }))
  await assert.rejects(failed, { message: 'Unavailable', status: 503 })
  const retry = api.bootstrap()
  resolve(json({ ok: true }))
  assert.deepEqual(await retry, { ok: true })
  assert.equal(calls, 3)
})

test('sales polls validate freshness, retain identity for 304, and accept changed refunds', async (t) => {
  const oldSales = [{ id: 'sale', refunds: [] }]
  const newSales = [{ id: 'sale', refunds: [{ status: 'processed', amount: 1000 }] }]
  const requests = []
  const responses = [json(oldSales, '"v1"'), new Response(null, { status: 304 }), json(newSales, '"v2"'), new Response('{"error":"Sign in"}', { status: 401 }), json(newSales, '"v2"')]
  const api = await client(t, async (_url, options) => { requests.push(options); return responses.shift() })
  const first = await api.sales()
  assert.equal(await api.sales(), first)
  assert.equal(requests[1].headers.get('If-None-Match'), '"v1"')
  assert.equal(requests[1].cache, 'no-cache')
  const changed = await api.sales()
  assert.notEqual(changed, first)
  assert.deepEqual(changed, newSales)
  await assert.rejects(api.sales(), { status: 401 })
  await api.sales()
  assert.equal(requests[4].headers.has('If-None-Match'), false)
})

test('mutations never coalesce and reads cannot reuse a pre-mutation response', async (t) => {
  let resolveOldRead
  let reads = 0
  let writes = 0
  const api = await client(t, async (_url, options) => {
    if (options.method === 'POST') { writes += 1; return json({ id: writes }) }
    reads += 1
    if (reads === 1) return new Promise(resolve => { resolveOldRead = resolve })
    if (reads === 2) return json([{ id: 'new' }], '"new"')
    assert.equal(options.headers.get('If-None-Match'), '"new"')
    return new Response(null, { status: 304 })
  })
  const old = api.sales()
  await Promise.all([api.cashSale([]), api.cashSale([])])
  const updated = await api.sales()
  resolveOldRead(json([{ id: 'old' }], '"old"'))
  await old
  assert.equal(await api.sales(), updated)
  assert.equal(writes, 2)
  assert.equal(reads, 3)
})
