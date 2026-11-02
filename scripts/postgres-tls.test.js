import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import { postgresConfig } from '../server/postgres.js'

// Explicit local integration check, kept outside server/*.test.js. The fixture
// certificate must be self-signed and valid for DNS:localhost only (no IP SAN).
const source = process.env.POSTGRES_TLS_TEST_URL
const caFile = process.env.POSTGRES_TLS_TEST_CA
if (!source || !caFile) throw new Error('Set POSTGRES_TLS_TEST_URL and POSTGRES_TLS_TEST_CA to a local TLS-enabled PostgreSQL fixture.')
const fixture = new URL(source)
if (!['localhost', '127.0.0.1', '[::1]'].includes(fixture.hostname.toLowerCase())) {
  throw new Error('The PostgreSQL TLS test fixture must use a loopback hostname.')
}
for (const key of ['ssl', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat']) fixture.searchParams.delete(key)

async function connect(url, env, inspect = async () => {}) {
  const client = new pg.Client(postgresConfig(url.href, env))
  try {
    await client.connect()
    return await inspect(client)
  } finally {
    await client.end()
  }
}

test('PostgreSQL rejects an untrusted self-signed server certificate', { timeout: 15000 }, async () => {
  const url = new URL(fixture)
  url.hostname = 'localhost'; url.searchParams.set('sslmode', 'verify-full')
  await assert.rejects(connect(url, {}), (error) => ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(error.code))
})

test('PostgreSQL connects with the explicit CA and confirms the real session uses TLS', { timeout: 15000 }, async () => {
  const url = new URL(fixture)
  url.hostname = 'localhost'; url.searchParams.set('sslmode', 'verify-full')
  await connect(url, { PGSSLROOTCERT: caFile }, async (client) => {
    const { rows: [session] } = await client.query('SELECT ssl,version,cipher FROM pg_stat_ssl WHERE pid=pg_backend_pid()')
    assert.equal(session.ssl, true)
    assert.match(session.version, /^TLS/)
    assert.ok(session.cipher)
  })
})

test('PostgreSQL rejects a trusted certificate for the wrong hostname', { timeout: 15000 }, async () => {
  const url = new URL(fixture)
  url.hostname = '127.0.0.1'; url.searchParams.set('sslmode', 'verify-full')
  await assert.rejects(connect(url, { PGSSLROOTCERT: caFile }), (error) => error.code === 'ERR_TLS_CERT_ALTNAME_INVALID')
})

test('URL sslmode=require cannot weaken hostname verification', { timeout: 15000 }, async () => {
  const url = new URL(fixture)
  url.hostname = '127.0.0.1'; url.searchParams.set('sslmode', 'require')
  url.searchParams.set('sslrootcert', caFile)
  await assert.rejects(connect(url, {}), (error) => error.code === 'ERR_TLS_CERT_ALTNAME_INVALID')
})
