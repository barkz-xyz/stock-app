import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { watchUpdates } from '../src/liveUpdates.js'

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
    assert.equal(reads, before + 1)
    sources[1].dispatchEvent(new Event('unauthorized'))
    assert.equal(expire, 1)
    assert.equal(sources[1].closed, true)
  } finally { stop() }
})

test('checkout attempts retain their key and frozen cart through a reload', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  const data = new Map()
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key),
  } })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous); else delete globalThis.sessionStorage })
  const first = await import(`../src/checkoutAttempts.js?first=${Math.random()}`)
  const attempt = first.beginCheckout([{ itemId: 'one', quantity: 2 }], 'cash', 2000)
  assert.match(attempt.key, /^[0-9a-f-]{36}$/)
  const reload = await import(`../src/checkoutAttempts.js?reload=${Math.random()}`)
  assert.deepEqual(reload.pendingCheckout(), attempt)
  assert.deepEqual(reload.beginCheckout([{ itemId: 'two', quantity: 4 }], 'card', 9999), attempt)
  reload.clearCheckout('another-key')
  assert.deepEqual(reload.pendingCheckout(), attempt)
  reload.clearCheckout(attempt.key)
  assert.equal(reload.pendingCheckout(), null)
  assert.notEqual(reload.beginCheckout(attempt.items, 'cash', 2000).key, attempt.key)
})
