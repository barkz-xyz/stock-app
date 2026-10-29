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

test('bootstrap validates freshness, retains identity for 304, and accepts changed refunds', async (t) => {
  const oldSales = { sales: [{ id: 'sale', refunds: [] }], total: 1 }
  const newSales = { sales: [{ id: 'sale', refunds: [{ status: 'processed', amount: 1000 }] }], total: 1 }
  const requests = []
  const responses = [json(oldSales, '"v1"'), new Response(null, { status: 304 }), json(newSales, '"v2"'), new Response('{"error":"Sign in"}', { status: 401 }), json(newSales, '"v2"')]
  const api = await client(t, async (_url, options) => { requests.push(options); return responses.shift() })
  const first = await api.bootstrap()
  assert.equal(await api.bootstrap(), first)
  assert.equal(requests[1].headers.get('If-None-Match'), '"v1"')
  assert.equal(requests[1].cache, 'no-cache')
  const changed = await api.bootstrap()
  assert.notEqual(changed, first)
  assert.deepEqual(changed, newSales)
  await assert.rejects(api.bootstrap(), { status: 401 })
  await api.bootstrap()
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
    if (reads === 2) return json({ sales: [{ id: 'new' }], total: 1 }, '"new"')
    assert.equal(options.headers.get('If-None-Match'), '"new"')
    return new Response(null, { status: 304 })
  })
  const old = api.bootstrap()
  await Promise.all([api.cashSale([]), api.cashSale([])])
  const updated = await api.bootstrap()
  resolveOldRead(json({ sales: [{ id: 'old' }], total: 1 }, '"old"'))
  await old
  assert.equal(await api.bootstrap(), updated)
  assert.equal(writes, 2)
  assert.equal(reads, 3)
})

test('checkout retries carry a stable key and never retry a write automatically', async (t) => {
  const calls = []
  const api = await client(t, async (url, options) => { calls.push({ url, options }); if (calls.length === 1) throw new TypeError('Lost response'); return json({ id: 'original' }) })
  await assert.rejects(api.cashSale([{ itemId: 'item', quantity: 1 }], 'key'), /Lost response/)
  assert.equal(calls.length, 1)
  await api.cashSale([{ itemId: 'item', quantity: 1 }], 'key')
  assert.ok(calls.every(call => call.options.headers.get('Idempotency-Key') === 'key'))
  assert.equal(calls[0].options.body, calls[1].options.body)
})

test('bootstrap retains equal branches and rows through 304, new ETags, and a mutation', async t => {
  const snapshot = { auth: { authenticated: true, user: { id: 'admin', role: 'admin' } },
    items: [{ id: 'a', quantity: 1.25 }, { id: 'b', quantity: 3 }], sales: [], registerSessions: [{ id: 'session' }] }
  const changed = { ...snapshot, items: [{ ...snapshot.items[0], quantity: 1 }, snapshot.items[1]] }
  const responses = [json(snapshot, '"one"'), new Response(null, { status: 304 }), json(snapshot, '"different-encoding"'), json({ ok: true }), json(changed, '"two"')]
  const requests = []
  const api = await client(t, async (_url, options) => { requests.push(options); return responses.shift() })
  const first = await api.bootstrap()
  assert.equal(await api.bootstrap(), first)
  assert.equal(await api.bootstrap(), first, 'Equivalent data with a different HTTP representation still shares state')
  await api.adjustItem('a', {})
  const next = await api.bootstrap()
  assert.notEqual(next, first); assert.notEqual(next.items, first.items)
  assert.notEqual(next.items[0], first.items[0]); assert.equal(next.items[1], first.items[1])
  assert.equal(next.auth, first.auth); assert.equal(next.sales, first.sales); assert.equal(next.registerSessions, first.registerSessions)
  assert.equal(requests[1].headers.get('If-None-Match'), '"one"')
  assert.equal(requests[4].headers.has('If-None-Match'), false, 'A write invalidates HTTP validators')
})

test('bootstrap forgets validators and retained staff data on session expiry and identity changes', async t => {
  const snapshot = { auth: { authenticated: true, user: { id: 'one' } }, items: [{ id: 'a' }] }
  const requests = []
  const responses = [json(snapshot, '"v1"'), new Response('{"error":"Expired"}', { status: 401 }), json(snapshot, '"v1"'), json({ authenticated: true }), json(snapshot, '"v1"')]
  const api = await client(t, async (_url, options) => { requests.push(options); return responses.shift() })
  const first = await api.bootstrap()
  await assert.rejects(api.bootstrap(), { status: 401 })
  const recovered = await api.bootstrap()
  assert.notEqual(recovered.items, first.items)
  await api.login('other', 'test-password')
  const other = await api.bootstrap()
  assert.notEqual(other.items, recovered.items)
  assert.equal(requests[2].headers.has('If-None-Match'), false)
  assert.equal(requests[4].headers.has('If-None-Match'), false)
})
