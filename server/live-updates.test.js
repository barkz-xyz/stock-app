import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createRefreshCoordinator, watchUpdates } from '../src/liveUpdates.js'

test('live updates refresh stock, coalesce bursts, recover missed updates, and stop when hidden or signed out', async () => {
  const sources = []
  class Source extends EventTarget {
    constructor(url) { super(); assert.equal(url, '/api/events'); sources.push(this) }
    close() { this.closed = true }
  }
  const doc = new EventTarget()
  doc.visibilityState = 'visible'
  const timers = { setTimeout(callback, ms) { if (ms < 100) return setTimeout(callback, ms); this.next = { callback, ms }; return 0 }, clearTimeout(id) { clearTimeout(id) } }
  let reads = 0
  let expire = 0
  let resolve
  const stop = watchUpdates({ document: doc, EventSource: Source, timers,
    refresh: async () => { reads++; if (reads === 2) await new Promise(done => { resolve = done }) }, onUnauthorized: () => expire++ })
  try {
    sources[0].dispatchEvent(new Event('ready'))
    await delay(0)
    assert.equal(reads, 1)
    assert.equal(timers.next.ms, 60000)
    for (let i = 0; i < 6; i++) sources[0].dispatchEvent(new Event('change'))
    await delay(110)
    assert.equal(reads, 2)
    sources[0].dispatchEvent(new Event('change'))
    await delay(110)
    resolve()
    await delay(0)
    assert.equal(reads, 3) // A change during an in-flight snapshot must not be lost.
    sources[0].onerror()
    assert.equal(timers.next.ms, 15000)
    doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange'))
    assert.equal(sources[0].closed, true)
    const before = reads
    await timers.next.callback()
    assert.equal(reads, before)
    doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange'))
    await delay(0)
    assert.equal(sources.length, 2)
    sources[0].dispatchEvent(new Event('ready'))
    sources[0].dispatchEvent(new Event('unauthorized'))
    assert.equal(expire, 0, 'Events from a closed connection do not affect the new one')
    assert.equal(reads, before, 'Visibility waits for ready instead of making a duplicate HTTP request')
    sources[1].dispatchEvent(new Event('ready'))
    await delay(0)
    assert.equal(reads, before + 1)
    sources[1].dispatchEvent(new Event('unauthorized'))
    assert.equal(expire, 1)
    assert.equal(sources[1].closed, true)
  } finally { stop() }
})

test('refresh coordinator shares initial/manual reads and queues one post-change reconciliation', async () => {
  const reads = []
  const refresh = createRefreshCoordinator(() => new Promise((resolve, reject) => reads.push({ resolve, reject })))
  const first = refresh(), manual = refresh()
  assert.equal(first, manual)
  assert.equal(reads.length, 1)
  for (let i = 0; i < 8; i++) assert.equal(refresh({ fresh: true }), first)
  reads[0].resolve()
  await delay(0)
  assert.equal(reads.length, 2)
  reads[1].resolve()
  await first
  const failed = refresh()
  reads[2].reject(Object.assign(new Error('Session expired'), { status: 401 }))
  await assert.rejects(failed, { status: 401 })
  const retry = refresh(); reads[3].resolve(); await retry
  assert.equal(reads.length, 4)
})

test('invalidating a refresh detaches old work and prevents its queued read after logout', async () => {
  const reads = []
  const refresh = createRefreshCoordinator(() => new Promise(resolve => reads.push(resolve)))
  const old = refresh(); refresh({ fresh: true }); refresh.invalidate()
  const current = refresh()
  reads[0](); await old
  assert.equal(reads.length, 2)
  assert.equal(refresh(), current)
  reads[1](); await current
})

test('SSE refresh errors retain polling recovery; 401 stops it', async () => {
  const doc = new EventTarget(); doc.visibilityState = 'visible'
  const timers = { setTimeout(callback, ms) { this.next = { callback, ms }; return 0 }, clearTimeout() {} }
  let reads = 0, unauthorized = 0
  const stop = watchUpdates({ document: doc, EventSource: null, timers, refresh: async () => {
    reads++; throw Object.assign(new Error('Unavailable'), { status: reads === 1 ? 503 : 401 })
  }, onUnauthorized: () => unauthorized++ })
  await timers.next.callback(); assert.equal(reads, 1); assert.equal(timers.next.ms, 15000)
  await timers.next.callback(); assert.equal(unauthorized, 1)
  await timers.next.callback(); assert.equal(reads, 2)
  stop()
})

test('checkout attempts retain their key and frozen cart through a reload', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  const data = new Map()
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key),
  } })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous); else delete globalThis.sessionStorage })
  const first = await import(`../src/checkoutAttempts.js?first=${Math.random()}`)
  const attempt = first.beginCheckout([{ itemId: 'one', quantity: 2 }], 'cash', 2000, 5000)
  assert.match(attempt.key, /^[0-9a-f-]{36}$/)
  const reload = await import(`../src/checkoutAttempts.js?reload=${Math.random()}`)
  assert.deepEqual(reload.pendingCheckout(), attempt)
  assert.equal(reload.pendingCheckout().cashReceived, 5000)
  assert.deepEqual(reload.beginCheckout([{ itemId: 'two', quantity: 4 }], 'card', 9999), attempt)
  reload.clearCheckout('another-key')
  assert.deepEqual(reload.pendingCheckout(), attempt)
  reload.clearCheckout(attempt.key)
  assert.equal(reload.pendingCheckout(), null)
  assert.notEqual(reload.beginCheckout(attempt.items, 'cash', 2000).key, attempt.key)
})
