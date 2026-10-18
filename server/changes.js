import { EventEmitter } from 'node:events'
import pg from 'pg'

const changes = new EventEmitter()
changes.setMaxListeners(0)
let listener
let retry
let stopped = false

export const publishChange = () => changes.emit('change')
export function subscribeToChanges(callback) {
  changes.on('change', callback)
  return () => changes.off('change', callback)
}

export async function listenForDatabaseChanges(connectionString) {
  if (!connectionString) return
  stopped = false
  const connect = async () => {
    if (stopped) return
    const client = new pg.Client({ connectionString,
      ssl: !connectionString.includes('railway.internal') && process.env.PGSSLMODE !== 'disable' ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 10000,
    })
    listener = client
    let disconnected = false
    const reconnect = () => {
      if (disconnected || stopped) return
      disconnected = true
      client.end().catch(() => {})
      retry = setTimeout(() => connect().catch(() => {}), 3000)
      retry.unref()
    }
    client.on('error', reconnect)
    client.on('end', reconnect)
    client.on('notification', message => { if (message.channel === 'bakery_changes') publishChange() })
    try {
      await client.connect()
      await client.query('LISTEN bakery_changes')
      // Reconcile changes that may have happened during a disconnected interval.
      publishChange()
    } catch (error) {
      console.error('Database change listener disconnected:', error.message)
      reconnect()
    }
  }
  await connect()
}

export async function closeChangeListener() {
  stopped = true
  clearTimeout(retry)
  await listener?.end().catch(() => {})
}
