import assert from 'node:assert/strict'
import test from 'node:test'
import { createRouter, isPlainNavigation, parseRoute, sectionHref } from '../src/routes.js'

test('every section and register tab can be restored from its URL', () => {
  for (const page of ['dashboard', 'pos', 'inventory', 'metrics', 'activity', 'settings']) {
    assert.equal(parseRoute(sectionHref(page)).page, page)
  }
  assert.equal(parseRoute('/').canonical, '/resumen')
  assert.equal(parseRoute('/inventario/').page, 'inventory')
  assert.equal(parseRoute('/caja/historial').registerView, 'history')
  assert.equal(parseRoute('/caja').registerView, 'cart')
  assert.equal(parseRoute('/caja/cierre').registerView, 'close')
  assert.equal(parseRoute(sectionHref('pos', { view: 'close', date: '2026-10-17' })).closureDate, '2026-10-17')
  for (const range of ['today', '7d', '30d']) assert.equal(parseRoute(sectionHref('metrics', { range })).metricsRange, range)
  assert.equal(parseRoute('/metricas?periodo=invalid').metricsRange, 'today')
  assert.equal(parseRoute('/something-unknown').page, 'not-found')
})

test('navigation supports refresh, back/forward and root replacement without duplicate entries', () => {
  const browser = new EventTarget()
  const entries = ['http://bakery.local/']
  let index = 0
  browser.location = new URL(entries[index])
  const update = () => { browser.location = new URL(entries[index]) }
  browser.history = {
    pushState(_state, _title, href) { entries.splice(++index); entries.push(new URL(href, browser.location.href).href); update() },
    replaceState(_state, _title, href) { entries[index] = new URL(href, browser.location.href).href; update() },
    back() { if (index > 0) { index--; update(); browser.dispatchEvent(new Event('popstate')) } },
    forward() { if (index < entries.length - 1) { index++; update(); browser.dispatchEvent(new Event('popstate')) } },
  }
  const router = createRouter(browser)
  let changes = 0
  const unsubscribe = router.subscribe(() => changes++)
  router.navigate('/resumen', { replace: true })
  router.navigate('/caja/historial')
  router.navigate('/caja/historial')
  router.navigate('/metricas?periodo=30d')
  assert.equal(entries.length, 3)
  assert.equal(changes, 3)
  assert.equal(parseRoute(createRouter(browser).getSnapshot()).metricsRange, '30d')
  browser.history.back()
  assert.equal(parseRoute(router.getSnapshot()).registerView, 'history')
  browser.history.back()
  assert.equal(router.getSnapshot(), '/resumen')
  browser.history.forward()
  assert.equal(router.getSnapshot(), '/caja/historial')
  assert.throws(() => router.navigate('https://another.example/'), /within this app/)
  unsubscribe()
  const before = changes
  router.navigate('/inventario')
  assert.equal(changes, before)
})

test('modified clicks and new-tab clicks retain native link behavior', () => {
  assert.equal(isPlainNavigation({ button: 0 }), true)
  for (const event of [{ button: 1 }, { button: 0, ctrlKey: true }, { button: 0, metaKey: true }, { button: 0, shiftKey: true }, { button: 0, altKey: true }, { button: 0, defaultPrevented: true }]) assert.equal(isPlainNavigation(event), false)
})
