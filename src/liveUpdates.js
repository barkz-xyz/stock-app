// Events contain no business data; each signal fetches a fresh authenticated snapshot.
export function watchUpdates({ refresh, onUnauthorized, document: doc = globalThis.document,
  EventSource: Source = globalThis.EventSource, timers = globalThis }) {
  let stopped = false
  let stream
  let connected = false
  let running = false
  let queued = false
  let debounce
  let timer
  const visible = () => doc.visibilityState === 'visible'
  const schedule = () => {
    timers.clearTimeout(timer)
    if (!stopped && visible()) timer = timers.setTimeout(sync, connected ? 60000 : 15000)
  }
  const sync = async () => {
    if (stopped || !visible()) return
    if (running) { queued = true; return }
    running = true
    try {
      do { queued = false; await refresh() } while (queued && !stopped && visible())
    } catch (error) {
      if (error.status === 401) { stop(); onUnauthorized?.() }
    } finally { running = false; schedule() }
  }
  const connect = () => {
    if (!visible() || stopped) return
    if (Source) {
      stream = new Source('/api/events')
      stream.addEventListener('ready', () => { connected = true; sync() })
      stream.addEventListener('change', () => {
        timers.clearTimeout(debounce)
        debounce = timers.setTimeout(sync, 75)
      })
      stream.addEventListener('unauthorized', () => { stop(); onUnauthorized?.() })
      stream.onerror = () => { connected = false; schedule() } // EventSource reconnects automatically.
    }
    schedule()
  }
  const visibility = () => {
    stream?.close(); stream = null; connected = false
    timers.clearTimeout(timer); timers.clearTimeout(debounce)
    if (visible()) { connect(); sync() }
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
