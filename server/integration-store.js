import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { assertClientHasNoStockHolds } from './stock-reservations.js'

export function integrationError(message, status = 400, code = 'INVALID_REQUEST') {
  return Object.assign(new Error(message), { status, code })
}

export const tokenDigest = token => crypto.createHash('sha256').update(token).digest('hex')
const iso = value => value == null ? null : new Date(value).toISOString()
const publicKey = key => ({
  id: key.id, prefix: key.prefix, createdAt: iso(key.createdAt ?? key.created_at),
  expiresAt: iso(key.expiresAt ?? key.expires_at), revokedAt: iso(key.revokedAt ?? key.revoked_at),
  lastUsedAt: iso(key.lastUsedAt ?? key.last_used_at),
})
const publicClient = client => ({
  id: client.id, name: client.name, environment: client.environment, scopes: client.scopes,
  createdAt: iso(client.createdAt ?? client.created_at), keys: (client.keys || []).map(publicKey),
})

function newKey(clientId, environment, expiresInDays) {
  const token = `bpos_${environment === 'production' ? 'live' : 'test'}_${crypto.randomBytes(32).toString('base64url')}`
  const now = Date.now()
  return { token, key: { id: crypto.randomUUID(), clientId, tokenHash: tokenDigest(token), prefix: token.slice(0, 18),
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + expiresInDays * 86400000).toISOString(), revokedAt: null, lastUsedAt: null } }
}

// File persistence is only for local development/tests. PostgreSQL shares keys
// and rate counters across every application replica.
export function createIntegrationStore({ pool, dataPath, readInventory }) {
  const filename = `${dataPath}.integrations.json`
  let queue = Promise.resolve()
  let nextCleanup = 0
  const read = async () => {
    try { return JSON.parse(await fs.readFile(filename, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return { clients: [], keys: [], limits: {} }; throw error }
  }
  const mutate = callback => {
    const operation = queue.then(async () => {
      const data = await read()
      const result = await callback(data)
      const temporary = `${filename}.${crypto.randomUUID()}.tmp`
      await fs.writeFile(temporary, JSON.stringify(data), { mode: 0o600 })
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(temporary, filename); break }
        catch (error) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 12) throw error
          await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)))
        }
      }
      return result
    })
    queue = operation.catch(() => {})
    return operation
  }
  const transaction = async callback => {
    const connection = await pool.connect()
    try { await connection.query('BEGIN'); const result = await callback(connection); await connection.query('COMMIT'); return result }
    catch (error) { await connection.query('ROLLBACK'); throw error }
    finally { connection.release() }
  }
  const insertKey = (connection, key) => connection.query(
    `INSERT INTO integration_keys (id,client_id,token_hash,prefix,created_at,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`, [key.id, key.clientId, key.tokenHash, key.prefix, key.createdAt, key.expiresAt])

  return {
    persistent: Boolean(pool),
    readInventory,
    async initialize() {
      if (!pool) return
      await pool.query(`
        CREATE TABLE IF NOT EXISTS integration_clients (
          id UUID PRIMARY KEY, name TEXT NOT NULL, environment TEXT NOT NULL CHECK(environment IN ('test','production')),
          scopes TEXT[] NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_by UUID
        );
        CREATE TABLE IF NOT EXISTS integration_keys (
          id UUID PRIMARY KEY, client_id UUID NOT NULL REFERENCES integration_clients(id), token_hash TEXT NOT NULL UNIQUE,
          prefix TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
          revoked_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS integration_keys_client_idx ON integration_keys(client_id);
        CREATE TABLE IF NOT EXISTS integration_rate_limits (
          bucket TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires_at TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS integration_rate_limits_expiry_idx ON integration_rate_limits(expires_at);
      `)
    },
    async listClients(environment) {
      if (!pool) {
        const data = await read()
        return data.clients.filter(client => client.environment === environment).map(client => publicClient({ ...client,
          keys: data.keys.filter(key => key.clientId === client.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }))
      }
      const { rows } = await pool.query(`SELECT c.id,c.name,c.environment,c.scopes,c.created_at,
        COALESCE(jsonb_agg(jsonb_build_object('id',k.id,'prefix',k.prefix,'createdAt',k.created_at,
          'expiresAt',k.expires_at,'revokedAt',k.revoked_at,'lastUsedAt',k.last_used_at) ORDER BY k.created_at DESC)
          FILTER (WHERE k.id IS NOT NULL),'[]') AS keys
        FROM integration_clients c LEFT JOIN integration_keys k ON k.client_id=c.id
        WHERE c.environment=$1 GROUP BY c.id ORDER BY c.created_at DESC,c.id`, [environment])
      return rows.map(publicClient)
    },
    async createClient({ name, environment, expiresInDays, createdBy, reservationsEnabled = false }) {
      const client = { id: crypto.randomUUID(), name, environment, scopes: reservationsEnabled ? ['inventory:read', 'inventory:reserve'] : ['inventory:read'], createdAt: new Date().toISOString() }
      const { token, key } = newKey(client.id, environment, expiresInDays)
      if (pool) await transaction(async connection => {
        await connection.query(`INSERT INTO integration_clients (id,name,environment,scopes,created_at,created_by)
          VALUES ($1,$2,$3,$4,$5,$6)`, [client.id, name, environment, client.scopes, client.createdAt, createdBy])
        await insertKey(connection, key)
      })
      else await mutate(data => { data.clients.unshift(client); data.keys.push(key) })
      return { client: publicClient({ ...client, keys: [key] }), key: publicKey(key), token }
    },
    async setReservationAccess(clientId, environment, enabled) {
      const scopes = enabled ? ['inventory:read', 'inventory:reserve'] : ['inventory:read']
      if (pool) await transaction(async connection => {
        const found = await connection.query('SELECT id FROM integration_clients WHERE id=$1 AND environment=$2 FOR UPDATE', [clientId, environment])
        if (!found.rowCount) throw integrationError('Integración no encontrada.', 404, 'NOT_FOUND')
        if (!enabled) await assertClientHasNoStockHolds(connection, clientId)
        await connection.query('UPDATE integration_clients SET scopes=$2 WHERE id=$1', [clientId, scopes])
      })
      else await mutate(data => {
        const client = data.clients.find(client => client.id === clientId && client.environment === environment)
        if (!client) throw integrationError('Integración no encontrada.', 404, 'NOT_FOUND')
        client.scopes = scopes
      })
      return { reservationsEnabled: enabled }
    },
    async rotateKey(clientId, environment, expiresInDays) {
      const { token, key } = newKey(clientId, environment, expiresInDays)
      if (pool) await transaction(async connection => {
        const found = await connection.query('SELECT id FROM integration_clients WHERE id=$1 AND environment=$2 FOR UPDATE', [clientId, environment])
        if (!found.rowCount) throw integrationError('Integración no encontrada.', 404, 'NOT_FOUND')
        const active = await connection.query('SELECT id FROM integration_keys WHERE client_id=$1 AND revoked_at IS NULL AND expires_at>NOW()', [clientId])
        if (active.rowCount >= 2) throw integrationError('Revoca la clave anterior antes de volver a rotar.', 409, 'KEY_ROTATION_CONFLICT')
        await connection.query("UPDATE integration_keys SET expires_at=LEAST(expires_at,NOW()+INTERVAL '24 hours') WHERE client_id=$1 AND revoked_at IS NULL", [clientId])
        await insertKey(connection, key)
      })
      else await mutate(data => {
        if (!data.clients.some(client => client.id === clientId && client.environment === environment)) throw integrationError('Integración no encontrada.', 404, 'NOT_FOUND')
        const active = data.keys.filter(k => k.clientId === clientId && !k.revokedAt && Date.parse(k.expiresAt) > Date.now())
        if (active.length >= 2) throw integrationError('Revoca la clave anterior antes de volver a rotar.', 409, 'KEY_ROTATION_CONFLICT')
        for (const old of active) old.expiresAt = new Date(Math.min(Date.parse(old.expiresAt), Date.now() + 86400000)).toISOString()
        data.keys.push(key)
      })
      return { key: publicKey(key), token }
    },
    async revokeKey(clientId, keyId, environment) {
      if (pool) {
        const result = await pool.query(`UPDATE integration_keys k SET revoked_at=COALESCE(k.revoked_at,NOW())
          FROM integration_clients c WHERE k.id=$1 AND k.client_id=$2 AND c.id=k.client_id AND c.environment=$3 RETURNING k.id`, [keyId, clientId, environment])
        if (!result.rowCount) throw integrationError('Clave no encontrada.', 404, 'NOT_FOUND')
      } else await mutate(data => {
        const key = data.keys.find(k => k.id === keyId && k.clientId === clientId)
        if (!key || !data.clients.some(c => c.id === clientId && c.environment === environment)) throw integrationError('Clave no encontrada.', 404, 'NOT_FOUND')
        key.revokedAt ||= new Date().toISOString()
      })
      return { revoked: true }
    },
    async deleteKey(clientId, keyId, environment) {
      if (pool) await transaction(async connection => {
        const client = await connection.query('SELECT id FROM integration_clients WHERE id=$1 AND environment=$2 FOR UPDATE', [clientId, environment])
        if (!client.rowCount) throw integrationError('Clave no encontrada.', 404, 'NOT_FOUND')
        const removed = await connection.query('DELETE FROM integration_keys WHERE id=$1 AND client_id=$2 RETURNING id', [keyId, clientId])
        if (!removed.rowCount) throw integrationError('Clave no encontrada.', 404, 'NOT_FOUND')
      })
      else await mutate(data => {
        if (!data.clients.some(client => client.id === clientId && client.environment === environment) ||
            !data.keys.some(key => key.id === keyId && key.clientId === clientId)) throw integrationError('Clave no encontrada.', 404, 'NOT_FOUND')
        data.keys = data.keys.filter(key => key.id !== keyId)
      })
      return { deleted: true }
    },
    async deleteClient(clientId, environment) {
      if (pool) await transaction(async connection => {
        const client = await connection.query('SELECT id FROM integration_clients WHERE id=$1 AND environment=$2 FOR UPDATE', [clientId, environment])
        if (!client.rowCount) throw integrationError('Integración no encontrada.', 404, 'NOT_FOUND')
        await assertClientHasNoStockHolds(connection, clientId)
        await connection.query('DELETE FROM integration_keys WHERE client_id=$1', [clientId])
        await connection.query('DELETE FROM integration_rate_limits WHERE bucket LIKE $1', [`client:${clientId}:%`])
        await connection.query('DELETE FROM integration_clients WHERE id=$1', [clientId])
      })
      else await mutate(data => {
        if (!data.clients.some(client => client.id === clientId && client.environment === environment)) throw integrationError('Integración no encontrada.', 404, 'NOT_FOUND')
        data.clients = data.clients.filter(client => client.id !== clientId)
        data.keys = data.keys.filter(key => key.clientId !== clientId)
        for (const bucket of Object.keys(data.limits)) if (bucket.startsWith(`client:${clientId}:`)) delete data.limits[bucket]
      })
      return { deleted: true }
    },
    async authenticate(digest, environment) {
      if (pool) {
        const { rows } = await pool.query(`SELECT c.id,c.scopes,k.id AS key_id FROM integration_keys k
          JOIN integration_clients c ON c.id=k.client_id
          WHERE k.token_hash=$1 AND c.environment=$2 AND k.revoked_at IS NULL AND k.expires_at>NOW()`, [digest, environment])
        if (!rows[0]) return null
        await pool.query(`UPDATE integration_keys SET last_used_at=NOW() WHERE id=$1 AND
          (last_used_at IS NULL OR last_used_at<NOW()-INTERVAL '1 minute')`, [rows[0].key_id])
        return { id: rows[0].id, scopes: rows[0].scopes }
      }
      return mutate(data => {
        const key = data.keys.find(k => k.tokenHash === digest && !k.revokedAt && Date.parse(k.expiresAt) > Date.now())
        const client = key && data.clients.find(c => c.id === key.clientId && c.environment === environment)
        if (!client) return null
        if (!key.lastUsedAt || Date.now() - Date.parse(key.lastUsedAt) >= 60000) key.lastUsedAt = new Date().toISOString()
        return { id: client.id, scopes: client.scopes }
      })
    },
    async consumeLimits(entries) {
      if (pool) {
        if (Date.now() > nextCleanup) {
          nextCleanup = Date.now() + 60000
          await pool.query('DELETE FROM integration_rate_limits WHERE expires_at<NOW()')
        }
        const { rows } = await pool.query(`WITH tick AS (SELECT extract(epoch FROM statement_timestamp()) AS now),
          windows AS (SELECT e.key||':'||floor(tick.now/e.seconds)::text AS bucket,
            to_timestamp((floor(tick.now/e.seconds)+1)*e.seconds) AS ends
            FROM unnest($1::text[],$2::integer[]) e(key,seconds) CROSS JOIN tick)
          INSERT INTO integration_rate_limits (bucket,hits,expires_at)
          SELECT bucket,1,ends FROM windows ORDER BY bucket
          ON CONFLICT (bucket) DO UPDATE SET hits=integration_rate_limits.hits+1
          RETURNING bucket,hits,GREATEST(1,ceil(extract(epoch FROM expires_at-statement_timestamp()))) AS retry_after`,
        [entries.map(e => e.key), entries.map(e => e.seconds)])
        const exceeded = rows.filter(row => row.hits > entries.find(e => row.bucket.startsWith(`${e.key}:`)).limit)
        return exceeded.length ? Math.max(...exceeded.map(row => Number(row.retry_after))) : 0
      }
      return mutate(data => {
        const now = Date.now()
        for (const [bucket, value] of Object.entries(data.limits)) if (value.ends <= now) delete data.limits[bucket]
        let retry = 0
        for (const entry of entries) {
          const window = entry.seconds * 1000
          const bucket = `${entry.key}:${Math.floor(now / window)}`
          const value = data.limits[bucket] ||= { hits: 0, ends: (Math.floor(now / window) + 1) * window }
          if (++value.hits > entry.limit) retry = Math.max(retry, Math.ceil((value.ends - now) / 1000))
        }
        return retry
      })
    },
  }
}
