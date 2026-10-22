// Events contain no business data; each signal fetches a fresh authenticated snapshot.
export function watchUpdates({ refresh, onUnauthorized, document: doc = globalThis.document,
  EventSource: Source = globalThis.EventSource, timers = globalThis }) {
  let stopped = false
  let stream
  let connected = false
  const reconcile = refresh.invalidate ? refresh : createRefreshCoordinator(refresh)
  let debounce
  let timer
  const visible = () => doc.visibilityState === 'visible'
  const schedule = () => {
    timers.clearTimeout(timer)
    if (!stopped && visible()) timer = timers.setTimeout(sync, connected ? 60000 : 15000)
  }
  const sync = async () => {
    if (stopped || !visible()) return
    try {
      await reconcile({ fresh: true })
    } catch (error) {
      if (error.status === 401 && !stopped) { stop(); onUnauthorized?.() }
    } finally { schedule() }
  }
  const connect = () => {
    if (!visible() || stopped) return
    if (Source) {
      const source = stream = new Source('/api/events')
      source.addEventListener('ready', () => { if (stream !== source || stopped) return; connected = true; sync() })
      source.addEventListener('change', () => {
        if (stream !== source || stopped) return
        timers.clearTimeout(debounce)
        debounce = timers.setTimeout(sync, 75)
      })
      source.addEventListener('unauthorized', () => { if (stream !== source || stopped) return; stop(); onUnauthorized?.() })
      source.onerror = () => { if (stream !== source || stopped) return; connected = false; schedule() } // EventSource reconnects automatically.
    }
    schedule()
  }
  const visibility = () => {
    stream?.close(); stream = null; connected = false
    timers.clearTimeout(timer); timers.clearTimeout(debounce)
    // ready reconciles visibility/reconnection gaps. Without SSE use HTTP immediately.
    if (visible()) { connect(); if (!Source) sync() }
  }
  function stop() {
    stopped = true
    stream?.close()
    timers.clearTimeout(timer); timers.clearTimeout(debounce)
    doc.removeEventListener('visibilitychange', visibility)
  }
  doc.addEventListener('visibilitychange', visibility)
  connect()
  return stop
}
// Shared by initial load, manual refresh, SSE and post-mutation reconciliation.
// A signal received during a read needs one subsequent read, never parallel reads.
export function createRefreshCoordinator(load) {
  let active = null
  const refresh = ({ fresh = false } = {}) => {
    if (active) { if (fresh) active.queued = true; return active.promise }
    const flight = { queued: false }
    const run = async () => {
      do { flight.queued = false; await load() } while (flight.queued && active === flight)
    }
    flight.promise = run().finally(() => { if (active === flight) active = null })
    active = flight
    return flight.promise
  }
  refresh.invalidate = () => { active = null }
  return refresh
}
