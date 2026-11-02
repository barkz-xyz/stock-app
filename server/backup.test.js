import assert from 'node:assert/strict'
import test from 'node:test'
import { archiveContents, assertRestoreTarget, backupToolEnvironment } from '../scripts/postgres-backup.js'

test('backup inventory reads the archive TOC without a fixed table allowlist', () => {
  assert.deepEqual(archiveContents(`; Archive metadata
215; 1259 1700 TABLE public items owner
216; 1259 1701 TABLE public newly_added_table owner
3300; 0 1700 TABLE DATA public items owner
3301; 0 1701 TABLE ATTACH public partition owner
260; 1255 1710 FUNCTION public bakery_notify_change() owner
3100; 2620 1711 TRIGGER public items bakery_changed owner
`), { tables: 2, functions: 1, triggers: 1 })
})

test('PostgreSQL tools receive credentials through environment with the shared TLS policy', () => {
  const local = backupToolEnvironment('postgresql://backup:secret%3Avalue@127.0.0.1:5440/fixture?sslmode=disable', {})
  assert.equal(local.PGHOST, '127.0.0.1')
  assert.equal(local.PGPORT, '5440')
  assert.equal(local.PGDATABASE, 'fixture')
  assert.equal(local.PGPASSWORD, 'secret:value')
  assert.equal(local.PGSSLMODE, 'disable')
  const external = backupToolEnvironment('postgresql://backup:secret@database.example/fixture?sslmode=require', {})
  assert.equal(external.PGSSLMODE, 'verify-full')
  assert.throws(() => backupToolEnvironment('postgresql://backup:secret@database.example/fixture?sslmode=disable', {}), /verified TLS/)
  assert.equal(backupToolEnvironment('postgresql://backup@localhost/fixture', { PGPASSWORD: 'environment-only-secret' }).PGPASSWORD, 'environment-only-secret')
  assert.throws(() => backupToolEnvironment('postgresql://localhost/dbname%3Dother', {}), /simple database name/)
  const protectedTarget = backupToolEnvironment('postgresql://backup@localhost/fixture', {
    PGHOSTADDR: '198.51.100.12', PGSERVICE: 'another-server', PGSERVICEFILE: '/private/service.conf',
    PGOPTIONS: '-c search_path=another_schema', PGPASSFILE: '/private/pgpass', PGREQUIRESSL: '0',
    PGSSLNEGOTIATION: 'direct', PGTARGETSESSIONATTRS: 'read-write', PATH: '/tools',
  })
  for (const variable of ['PGHOSTADDR','PGSERVICE','PGSERVICEFILE','PGOPTIONS','PGPASSFILE','PGREQUIRESSL','PGSSLNEGOTIATION','PGTARGETSESSIONATTRS']) assert.equal(variable in protectedTarget, false)
  assert.equal(protectedTarget.PGHOST, 'localhost')
  assert.equal(protectedTarget.PGDATABASE, 'fixture')
  assert.equal(protectedTarget.PATH, '/tools')
})

test('restore requires an explicit distinct target and confirmation; remote targets require opt-in', () => {
  const source = { sourceDatabase: 'bakery', sourceHost: 'localhost', sourcePort: '5432' }
  assert.throws(() => assertRestoreTarget(null, source, {}), /RESTORE_DATABASE_URL/)
  assert.throws(() => assertRestoreTarget('postgresql://localhost/restored', source, {}), /RESTORE_CONFIRM_DATABASE/)
  assert.throws(() => assertRestoreTarget('postgresql://localhost/bakery', source, { RESTORE_CONFIRM_DATABASE: 'bakery' }), /distinct from the source/)
  assert.throws(() => assertRestoreTarget('postgresql://localhost/postgres', source, { RESTORE_CONFIRM_DATABASE: 'postgres' }), /maintenance/)
  assert.throws(() => assertRestoreTarget('postgresql://localhost/postgresql%3A%2F%2Fother%2Fdatabase', source,
    { RESTORE_CONFIRM_DATABASE: 'postgresql://other/database' }), /simple database name/)
  assert.throws(() => assertRestoreTarget('postgresql://other.example/bakery', source, { RESTORE_CONFIRM_DATABASE: 'bakery' }), /RESTORE_ALLOW_REMOTE/)
  assert.equal(assertRestoreTarget('postgresql://other.example/bakery', source,
    { RESTORE_CONFIRM_DATABASE: 'bakery', RESTORE_ALLOW_REMOTE: 'true' }), 'bakery')
  assert.equal(assertRestoreTarget('postgresql://localhost:5440/bakery', source, { RESTORE_CONFIRM_DATABASE: 'bakery' }), 'bakery')
})
