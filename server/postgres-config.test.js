import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import pg from 'pg'
import { isPrivateDatabaseHost, postgresConfig } from './postgres.js'

test('public PostgreSQL connections always verify TLS after pg parses the normalized URL', () => {
  for (const mode of ['', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']) {
    const url = new URL('postgresql://fixture:local-password@database.example.test:5432/stock')
    if (mode) url.searchParams.set('sslmode', mode)
    url.searchParams.set('ssl', 'false')
    url.searchParams.set('uselibpqcompat', 'true')
    url.searchParams.set('application_name', 'tls-regression')
    const config = postgresConfig(url.href, {})
    assert.equal(config.ssl.rejectUnauthorized, true)
    const normalized = new URL(config.connectionString)
    for (const key of ['sslmode', 'ssl', 'uselibpqcompat']) assert.equal(normalized.searchParams.has(key), false)
    assert.equal(normalized.searchParams.get('application_name'), 'tls-regression')
    const effective = new pg.Client(config).connectionParameters
    assert.equal(effective.host, 'database.example.test')
    assert.equal(effective.port, 5432)
    assert.equal(effective.ssl.rejectUnauthorized, true, 'pg must not replace the verified TLS object from URI flags')
  }
  for (const mode of ['disable', 'no-verify']) {
    assert.throws(() => postgresConfig(`postgresql://fixture@database.example.test/stock?sslmode=${mode}`, {}), /require verified TLS/)
    assert.throws(() => postgresConfig('postgresql://fixture@database.example.test/stock', { PGSSLMODE: mode }), /require verified TLS/)
  }
})

test('plaintext PostgreSQL is restricted to loopback and exact Railway private hostnames', () => {
  for (const hostname of ['localhost', '127.0.0.1', '[::1]', 'postgres.railway.internal', 'POSTGRES.RAILWAY.INTERNAL']) {
    assert.equal(isPrivateDatabaseHost(hostname), true, hostname)
    const config = postgresConfig(`postgresql://fixture@${hostname}/stock`, {})
    assert.equal(config.ssl, false)
    assert.equal(new pg.Client(config).connectionParameters.ssl, false)
    assert.equal(postgresConfig(`postgresql://fixture@${hostname}/stock?sslmode=verify-full`, {}).ssl.rejectUnauthorized, true)
  }
  for (const hostname of ['localhost.example.test', '127.0.0.1.example.test', 'railway.internal.example.test', 'postgres.railway.internal.example.test', 'evilrailway.internal', '10.0.0.1', 'railway.internal']) {
    assert.equal(isPrivateDatabaseHost(hostname), false, hostname)
    assert.equal(postgresConfig(`postgresql://fixture@${hostname}/stock`, {}).ssl.rejectUnauthorized, true)
    assert.throws(() => postgresConfig(`postgresql://fixture@${hostname}/stock?sslmode=disable`, {}), /require verified TLS/)
  }
})

test('PostgreSQL URL query parameters cannot override the host or connection identity', () => {
  for (const [key, value] of Object.entries({
    host: 'database.example.test', hostaddr: '198.51.100.1', port: '6543', user: 'another-role',
    password: 'secret-override', database: 'another-database', dbname: 'another-database', service: 'another-service',
  })) {
    const url = new URL('postgresql://fixture:local-password@localhost:5432/stock')
    url.searchParams.set(key, value)
    assert.throws(() => postgresConfig(url.href, {}), (error) => !error.message.includes(value) && /query|override|parameter/i.test(error.message))
  }
  const config = postgresConfig('postgresql://fixture@localhost/stock?options=-c%20search_path%3Disolated_fixture', {})
  assert.equal(new pg.Client(config).connectionParameters.options, '-c search_path=isolated_fixture')
})

test('PostgreSQL CA and client certificate files survive URL normalization', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bakery-tls-config-'))
  try {
    const files = { ca: 'local-ca.pem', cert: 'local-client.pem', key: 'local-client-key.pem' }
    for (const [kind, filename] of Object.entries(files)) await fs.writeFile(path.join(directory, filename), `Local ${kind} fixture`)
    const env = { PGSSLROOTCERT: path.join(directory, files.ca), PGSSLCERT: path.join(directory, files.cert), PGSSLKEY: path.join(directory, files.key) }
    const url = new URL('postgresql://fixture@database.example.test/stock?sslmode=require')
    for (const fromUrl of [false, true]) {
      if (fromUrl) {
        url.searchParams.set('sslrootcert', env.PGSSLROOTCERT)
        url.searchParams.set('sslcert', env.PGSSLCERT)
        url.searchParams.set('sslkey', env.PGSSLKEY)
      }
      const config = postgresConfig(url.href, fromUrl ? {} : env)
      const effective = new pg.Client(config).connectionParameters.ssl
      assert.equal(effective.rejectUnauthorized, true)
      for (const kind of Object.keys(files)) assert.deepEqual(effective[kind], Buffer.from(`Local ${kind} fixture`))
      for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) assert.equal(new URL(config.connectionString).searchParams.has(key), false)
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('invalid database configuration errors do not disclose credentials or certificate paths', () => {
  for (const source of ['not-a-database-url with-private-password', 'https://fixture:private-password@database.example.test/stock']) {
    assert.throws(() => postgresConfig(source, {}), (error) => error.message === 'A valid PostgreSQL connection URL is required.')
  }
  assert.throws(() => postgresConfig('postgresql://fixture:private-password@database.example.test/stock?sslmode=unexpected-mode', {}), { message: 'Unsupported PostgreSQL TLS mode.' })
  for (const [option, kind] of [['PGSSLROOTCERT', 'ca'], ['PGSSLCERT', 'cert'], ['PGSSLKEY', 'key']]) {
    assert.throws(() => postgresConfig('postgresql://fixture:private-password@database.example.test/stock', {
      [option]: '/does-not-exist/private-certificate-location.pem',
    }), (error) => error.message === `Cannot read PostgreSQL ${kind} certificate file.` && !error.cause)
  }
})
