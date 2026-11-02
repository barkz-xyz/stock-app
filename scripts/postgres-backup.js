import crypto from 'node:crypto'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import pg from 'pg'
import { postgresConfig } from '../server/postgres.js'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const format = 'bakery-pos-postgres-custom-v2'
const quoteIdentifier = value => `"${value.replaceAll('"', '""')}"`
function simpleDatabaseName(value) {
  // libpq treats names containing '=' or a URI prefix as new connection strings.
  // Do not let a database name redirect pg_dump/pg_restore to another endpoint.
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_$.-]{0,62}$/.test(value)) throw new Error('PostgreSQL backup tools require an explicit simple database name (letters, digits, _, $, . or -).')
  return value
}
const inside = (parent, target) => {
  const relative = path.relative(parent, target)
  return relative === '' || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

export function backupToolEnvironment(connectionString, env = process.env) {
  const config = postgresConfig(connectionString, env)
  const original = new URL(connectionString)
  const parameters = new pg.Client(config).connectionParameters
  // libpq has routing/credential options that node-postgres does not consume
  // (notably PGHOSTADDR). Build PG* settings only from the validated target.
  const base = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('PG')))
  const result = { ...base, PGDATABASE: simpleDatabaseName(parameters.database), PGHOST: parameters.host, PGPORT: String(parameters.port),
    PGUSER: parameters.user, PGPASSWORD: original.password ? parameters.password : env.PGPASSWORD || '',
    PGSSLMODE: config.ssl ? 'verify-full' : 'disable', PGCONNECT_TIMEOUT: '10' }
  if (original.searchParams.get('options')) result.PGOPTIONS = original.searchParams.get('options')
  // Connection credentials belong only in the child environment, never argv.
  delete result.PGSERVICE
  delete result.PGSERVICEFILE
  for (const [variable, parameter] of [['PGSSLROOTCERT', 'sslrootcert'], ['PGSSLCERT', 'sslcert'], ['PGSSLKEY', 'sslkey']]) {
    delete result[variable]
    const filename = original.searchParams.get(parameter) || env[variable]
    if (config.ssl && filename) result[variable] = filename
  }
  return result
}

async function tool(executable, args, env, { input, output, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, windowsHide: true,
      stdio: [input ?? 'ignore', output ?? (capture ? 'pipe' : 'ignore'), 'ignore'] })
    let text = ''
    if (capture) child.stdout.on('data', chunk => { text += chunk })
    child.once('error', () => reject(new Error(`${path.basename(executable)} could not start. Install matching PostgreSQL client tools or configure their paths.`)))
    // PostgreSQL errors can echo connection strings or row contents. Do not relay them.
    child.once('close', code => code === 0 ? resolve(text) : reject(new Error(`${path.basename(executable)} failed (exit ${code ?? 'signal'}). Check tool/server versions, connection permissions and TLS configuration.`)))
  })
}

async function backupDirectory(directory) {
  if (!directory || !path.isAbsolute(directory)) throw new Error('BACKUP_DIRECTORY must be an absolute persistent directory outside the application checkout.')
  if (inside(projectRoot, path.resolve(directory))) throw new Error('BACKUP_DIRECTORY must be outside the application checkout.')
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const actual = await fs.realpath(directory)
  if (inside(await fs.realpath(projectRoot), actual)) throw new Error('BACKUP_DIRECTORY resolves inside the application checkout.')
  const stat = await fs.stat(actual)
  if (process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error('BACKUP_DIRECTORY must have permissions 0700; restrict the directory before proceeding.')
  return actual
}

async function digest(handle) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) hash.update(chunk)
  return hash.digest('hex')
}

export function archiveContents(listing) {
  const entries = listing.split(/\r?\n/).filter(line => /^\d+;/.test(line))
  return {
    tables: entries.filter(line => /^\d+;\s+\d+\s+\d+\s+(?:FOREIGN )?TABLE (?!DATA |ATTACH )/.test(line)).length,
    functions: entries.filter(line => /^\d+;\s+\d+\s+\d+\s+FUNCTION /.test(line)).length,
    triggers: entries.filter(line => /^\d+;\s+\d+\s+\d+\s+TRIGGER /.test(line)).length,
  }
}

async function exclusiveWrite(filename, data) {
  const handle = await fs.open(filename, 'wx', 0o600)
  let complete = false
  try { await handle.writeFile(data); await handle.sync(); complete = true }
  finally {
    await handle.close()
    if (!complete) await fs.unlink(filename).catch(() => {})
  }
}

export async function createPostgresBackup({ env = process.env } = {}) {
  const connectionString = env.BACKUP_DATABASE_URL || env.DATABASE_URL
  if (!connectionString) throw new Error('BACKUP_DATABASE_URL or DATABASE_URL is required.')
  const childEnv = backupToolEnvironment(connectionString, env)
  const directory = await backupDirectory(env.BACKUP_DIRECTORY)
  const createdAt = new Date().toISOString()
  const stamp = createdAt.replaceAll(':', '-').replaceAll('.', '-')
  const file = path.join(directory, `postgres-${stamp}-${crypto.randomUUID()}.dump`)
  const written = []
  let handle
  try {
    handle = await fs.open(file, 'wx+', 0o600)
    written.push(file)
    await tool(env.PG_DUMP_PATH || 'pg_dump', ['--format=custom', '--compress=6', '--no-owner', '--no-acl', '--no-password', '--lock-wait-timeout=10000'], childEnv, { output: handle.fd })
    await handle.sync()
    const sha256 = await digest(handle)
    const stat = await handle.stat()
    await handle.close()
    handle = null
    const contents = archiveContents(await tool(env.PG_RESTORE_PATH || 'pg_restore', ['--list', file], childEnv, { capture: true }))
    if (!contents.tables) throw new Error('Backup has no application tables; no completed backup was published.')
    const manifest = { format, createdAt, archive: path.basename(file), sourceDatabase: childEnv.PGDATABASE,
      sourceHost: childEnv.PGHOST, sourcePort: childEnv.PGPORT, sha256, bytes: stat.size, contents }
    // Publish integrity metadata last. An interrupted archive is never restorable.
    await exclusiveWrite(`${file}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)
    written.push(`${file}.manifest.json`)
    await exclusiveWrite(`${file}.sha256`, `${sha256}  ${path.basename(file)}\n`)
    written.push(`${file}.sha256`)
    return { file, ...manifest }
  } catch (error) {
    await handle?.close().catch(() => {})
    await Promise.all(written.map(filename => fs.unlink(filename).catch(() => {})))
    throw error
  }
}

async function checkedArchive(archive) {
  if (!archive || !path.isAbsolute(archive)) throw new Error('Pass an absolute .dump archive path to restore-postgres.js.')
  const handle = await fs.open(archive, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('Backup archive must be a regular file.')
    const manifest = JSON.parse(await fs.readFile(`${archive}.manifest.json`, 'utf8'))
    const checksum = await fs.readFile(`${archive}.sha256`, 'utf8')
    const match = checksum.match(/^([a-f0-9]{64})  ([^\r\n]+)\r?\n?$/)
    if (!match || !Number.isSafeInteger(manifest.contents?.tables) || manifest.contents.tables < 1 ||
        !['sourceDatabase', 'sourceHost', 'sourcePort'].every(key => typeof manifest[key] === 'string' && manifest[key]) ||
        match[2] !== path.basename(archive) || manifest.format !== format ||
        manifest.archive !== path.basename(archive) || manifest.sha256 !== match[1] || manifest.bytes !== stat.size ||
        match[1] !== await digest(handle)) throw new Error('Backup integrity verification failed. Restore was not started.')
    const magic = Buffer.alloc(5)
    await handle.read(magic, 0, 5, 0)
    if (magic.toString() !== 'PGDMP') throw new Error('Backup is not a PostgreSQL custom archive.')
    return { handle, manifest }
  } catch (error) { await handle.close(); throw error }
}

export function assertRestoreTarget(connectionString, manifest, env = process.env) {
  if (!connectionString) throw new Error('RESTORE_DATABASE_URL is required; restore never falls back to the application database.')
  const target = new URL(connectionString)
  const database = simpleDatabaseName(decodeURIComponent(target.pathname.slice(1)))
  if (!database || env.RESTORE_CONFIRM_DATABASE !== database) throw new Error('RESTORE_CONFIRM_DATABASE must exactly match the target database name.')
  if (['postgres', 'template0', 'template1'].includes(database) || database === manifest.sourceDatabase &&
      target.hostname === manifest.sourceHost && (target.port || '5432') === manifest.sourcePort) throw new Error('Restore requires a new target distinct from the source and maintenance databases.')
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(target.hostname)
  if (!loopback && env.RESTORE_ALLOW_REMOTE !== 'true') throw new Error('Remote restore requires RESTORE_ALLOW_REMOTE=true and an isolated, empty target.')
  return database
}

export async function restorePostgresBackup({ archive, env = process.env } = {}) {
  const { handle, manifest } = await checkedArchive(archive)
  let client
  try {
    const connectionString = env.RESTORE_DATABASE_URL
    const database = assertRestoreTarget(connectionString, manifest, env)
    const childEnv = backupToolEnvironment(connectionString, env)
    client = new pg.Client(postgresConfig(connectionString, env))
    try { await client.connect() } catch { throw new Error('Could not connect to restore target; check target credentials and verified TLS configuration.') }
    const identity = (await client.query('SELECT current_database() AS database')).rows[0]
    if (identity.database !== database) throw new Error('Connected database differs from the explicitly confirmed target.')
    const { rows: [state] } = await client.query(`SELECT
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_(toast|temp)') +
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_(toast|temp)') +
      (SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema','public') AND nspname !~ '^pg_(toast|temp)') +
      (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typtype IN ('e','d') AND n.nspname NOT IN ('pg_catalog','information_schema')) +
      (SELECT count(*) FROM pg_extension WHERE extname<>'plpgsql') +
      (SELECT count(*) FROM pg_largeobject_metadata) AS objects,
      (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()) AS connections`)
    if (Number(state.objects) || Number(state.connections)) throw new Error('Restore target must be empty with no other database sessions. Stop the target application before restoring.')
    // No --clean: existing objects are never removed. All archive DDL/data is atomic.
    // Reuse the verified open descriptor to prevent swapping the archive path.
    await tool(env.PG_RESTORE_PATH || 'pg_restore', ['--dbname', database, '--single-transaction', '--exit-on-error', '--no-owner', '--no-acl', '--no-password'], childEnv, { input: handle.fd })
    let invalidatedSessions = 0
    await client.query('BEGIN')
    try {
      const sessions = await client.query("SELECT table_schema FROM information_schema.tables WHERE table_name='auth_sessions' AND table_type='BASE TABLE'")
      for (const row of sessions.rows) invalidatedSessions += (await client.query(`DELETE FROM ${quoteIdentifier(row.table_schema)}.auth_sessions`)).rowCount
      await client.query('COMMIT')
    } catch { await client.query('ROLLBACK'); throw new Error('Restore completed, but session invalidation failed. Keep the target offline and invalidate auth_sessions before use.') }
    const tables = Number((await client.query("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','f') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_(toast|temp)'")).rows[0].count)
    if (tables !== manifest.contents.tables) throw new Error('Restored table count differs from the verified archive. Keep target offline for investigation.')
    return { restored: true, database, tables, invalidatedSessions, sha256: manifest.sha256 }
  } finally { await client?.end().catch(() => {}); await handle.close() }
}
