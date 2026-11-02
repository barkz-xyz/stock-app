import fs from 'node:fs'
import tls from 'node:tls'

export function isPrivateDatabaseHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return ['localhost', '127.0.0.1', '::1'].includes(host) || host.endsWith('.railway.internal')
}

// Normalize TLS once: pg connection-string SSL options otherwise replace its ssl object.
export function postgresConfig(connectionString, env = process.env) {
  let url
  try { url = new URL(connectionString) } catch { throw new Error('A valid PostgreSQL connection URL is required.') }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) throw new Error('A valid PostgreSQL connection URL is required.')
  for (const key of ['host', 'hostaddr', 'port', 'user', 'password', 'database', 'dbname', 'service']) {
    if (url.searchParams.has(key)) throw new Error('PostgreSQL connection authority must be specified in the URL, not query parameters.')
  }
  const privateHost = isPrivateDatabaseHost(url.hostname)
  const mode = url.searchParams.get('sslmode') || env.PGSSLMODE || (privateHost ? 'disable' : 'verify-full')
  if (!['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full', 'no-verify'].includes(mode)) throw new Error('Unsupported PostgreSQL TLS mode.')
  if (!privateHost && ['disable', 'no-verify'].includes(mode)) throw new Error('Public PostgreSQL connections require verified TLS. Configure PGSSLROOTCERT for a private CA.')
  const files = {
    ca: url.searchParams.get('sslrootcert') || env.PGSSLROOTCERT,
    cert: url.searchParams.get('sslcert') || env.PGSSLCERT,
    key: url.searchParams.get('sslkey') || env.PGSSLKEY,
  }
  for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl', 'uselibpqcompat']) url.searchParams.delete(key)
  // pg omits TLS SNI for IP literals; pin verification to the actual URL host
  // rather than letting a socket-upgrade default verify "localhost" instead.
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const ssl = privateHost && mode === 'disable' ? false : {
    rejectUnauthorized: true,
    checkServerIdentity: (_servername, certificate) => tls.checkServerIdentity(hostname, certificate),
  }
  if (ssl) for (const [key, file] of Object.entries(files)) {
    if (!file) continue
    try { ssl[key] = fs.readFileSync(file) } catch { throw new Error(`Cannot read PostgreSQL ${key} certificate file.`) }
  }
  return { connectionString: url.href, ssl, connectionTimeoutMillis: 10000 }
}

export function isProductionDatabaseEnvironment(env = process.env) {
  return env.NODE_ENV === 'production' || Boolean(env.RAILWAY_PROJECT_ID || env.RAILWAY_ENVIRONMENT_ID)
}

export async function assertLimitedRuntimeRole(pool) {
  const { rows: [role] } = await pool.query(`SELECT r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
    has_schema_privilege(current_user,current_schema(),'CREATE') AS schema_create,
    pg_has_role(current_user,d.datdba,'MEMBER') AS owns_database,
    EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS has_memberships,
    EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relowner=r.oid AND n.nspname=current_schema())
      OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proowner=r.oid AND n.nspname=current_schema()) AS owns_objects
    FROM pg_roles r JOIN pg_database d ON d.datname=current_database() WHERE r.rolname=current_user`)
  if (!role || Object.values(role).some(Boolean)) {
    throw new Error('DATABASE_URL must use a limited runtime role without database ownership, schema CREATE, or administrative privileges. Run provision:postgres with a separate administrator connection.')
  }
}
