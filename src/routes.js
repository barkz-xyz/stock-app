export const sectionPaths = {
  dashboard: '/resumen', pos: '/caja', inventory: '/inventario',
  metrics: '/metricas', activity: '/actividad', settings: '/configuracion', users:'/usuarios',
}

export function sectionHref(page, { view = 'cart', range = 'today', date } = {}) {
  if (page === 'pos' && view === 'close') return `/caja/cierre${date ? `?fecha=${encodeURIComponent(date)}` : ''}`
  if (page === 'pos' && view === 'history') return '/caja/historial'
  if (page === 'metrics' && ['7d', '30d'].includes(range)) return `/metricas?periodo=${range}`
  return sectionPaths[page] || sectionPaths.dashboard
}

export function parseRoute(href) {
  const url = new URL(href, 'http://app.local')
  const path = url.pathname.replace(/\/+$/, '') || '/'
  const page = path === '/' ? 'dashboard' : ['/caja/historial', '/caja/cierre'].includes(path) ? 'pos'
    : Object.keys(sectionPaths).find(page => sectionPaths[page] === path) || 'not-found'
  const range = url.searchParams.get('periodo')
  return { page, registerView: path === '/caja/cierre' ? 'close' : path === '/caja/historial' ? 'history' : 'cart',
    closureDate: url.searchParams.get('fecha') || '', registerSessionId:url.searchParams.get('sesion')||'',
    metricsRange: ['7d', '30d'].includes(range) ? range : 'today',
    settingsTab: url.searchParams.get('tab') === 'inventory-api' ? 'inventory-api' : 'point',
    canonical: path === '/' ? sectionPaths.dashboard : null }
}

export function createRouter(browser) {
  const eventName = 'bakery:navigate'
  const getSnapshot = () => browser.location.pathname + browser.location.search
  return {
    getSnapshot,
    subscribe(callback) {
      browser.addEventListener('popstate', callback)
      browser.addEventListener(eventName, callback)
      return () => {
        browser.removeEventListener('popstate', callback)
        browser.removeEventListener(eventName, callback)
      }
    },
    navigate(href, { replace = false } = {}) {
      const target = new URL(href, browser.location.href)
      if (target.origin !== browser.location.origin) throw new Error('Navigation must stay within this app.')
      const next = target.pathname + target.search
      if (next === getSnapshot()) return
      browser.history[replace ? 'replaceState' : 'pushState'](null, '', next)
      browser.dispatchEvent(new Event(eventName))
    },
  }
}

export const isPlainNavigation = event => !event.defaultPrevented && event.button === 0 &&
  !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
