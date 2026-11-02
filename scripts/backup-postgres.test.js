import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawn } from 'node:child_process'
import pg from 'pg'
import { postgresConfig } from '../server/postgres.js'
import { migrateDatabase } from '../server/schema.js'
import { createIntegrationStore, tokenDigest } from '../server/integration-store.js'
import { createStockReservationStore } from '../server/stock-reservations.js'
import { createPostgresBackup, restorePostgresBackup } from './postgres-backup.js'

const quote = value => `"${value.replaceAll('"', '""')}"`
const testConnection = process.env.BACKUP_TEST_DATABASE_URL

const shellWorkflow = env => new Promise((resolve, reject) => {
  const child = spawn('bash', ['scripts/backup-postgres-offsite.sh'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  child.once('error', reject)
  child.once('close', code => resolve({ code, output }))
})

async function snapshot(pool) {
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows
  const result = {}
  for (const { tablename } of tables) {
    // Only hashes/counts reach assertions, even on a regression involving credentials.
    result[tablename] = (await pool.query(`SELECT count(*)::int AS rows,md5(COALESCE(string_agg(t::text,E'\\n' ORDER BY t::text),'')) AS digest FROM public.${quote(tablename)} t`)).rows[0]
  }
  return result
}

test('complete PostgreSQL archives restore all tables, credentials, cash ledger, reservations and database behavior', { skip: !testConnection }, async () => {
  const adminUrl = new URL(testConnection)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(adminUrl.hostname), 'Backup integration tests accept only a local loopback PostgreSQL instance')
  const admin = new pg.Client(postgresConfig(testConnection))
  const suffix = crypto.randomUUID().replaceAll('-', '')
  const sourceName = `backup_source_${suffix}`
  const targetName = `backup_restore_${suffix}`
  const sourceUrl = new URL(testConnection); sourceUrl.pathname = `/${sourceName}`
  const targetUrl = new URL(testConnection); targetUrl.pathname = `/${targetName}`
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bakery-backup-'))
  const source = new pg.Pool(postgresConfig(sourceUrl.href))
  let target
  const env = { ...process.env, BACKUP_DATABASE_URL: sourceUrl.href, BACKUP_DIRECTORY: directory,
    RESTORE_DATABASE_URL: targetUrl.href, RESTORE_CONFIRM_DATABASE: targetName }
  try {
    await admin.connect()
    await admin.query(`CREATE DATABASE ${quote(sourceName)}`)
    await admin.query(`CREATE DATABASE ${quote(targetName)}`)
    await migrateDatabase(source)
    const userId = crypto.randomUUID(), sessionId = crypto.randomUUID(), withdrawalId = crypto.randomUUID(), itemId = crypto.randomUUID()
    await source.query("INSERT INTO app_users(id,username,name,role,password_hash) VALUES($1,'backup-fixture','Backup fixture','admin',$2)", [userId, crypto.randomBytes(48).toString('hex')])
    await source.query("INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '1 hour')", [crypto.randomBytes(32).toString('hex'), userId])
    await source.query("INSERT INTO register_sessions(id,user_id,operator,opening_cash) VALUES($1,$2,'Backup fixture',1000)", [sessionId, userId])
    await source.query("INSERT INTO register_cash_withdrawals(id,session_id,amount,recipient,purpose,created_by) VALUES($1,$2,100,'Fixture','Restoration drill',$3)", [withdrawalId, sessionId, userId])
    await source.query("INSERT INTO register_cash_entries(id,session_id,withdrawal_id,kind,amount,created_by) VALUES($1,$2,$3,'withdrawal',100,$4)", [crypto.randomUUID(), sessionId, withdrawalId, userId])
    await source.query("INSERT INTO register_cash_operations(id,user_id,kind,fingerprint,result_id) VALUES($1,$2,'withdrawal','fixture',$3)", [crypto.randomUUID(), userId, withdrawalId])
    await source.query("INSERT INTO items(id,name,category,unit,quantity,price,sellable) VALUES($1,'Fixture bread','Bread','pieces',10,500,TRUE)", [itemId])
    const integration = createIntegrationStore({ pool: source })
    const issued = await integration.createClient({ name: 'Backup fixture', environment: 'test', expiresInDays: 1, reservationsEnabled: true })
    await integration.consumeLimits([{ key: `client:${issued.client.id}:minute`, seconds: 60, limit: 60 }])
    await createStockReservationStore({ pool: source }).create(issued.client, crypto.randomUUID(), {
      externalReference: 'backup-drill', currency: 'CLP', expectedTotal: 500,
      items: [{ itemId, quantity: '1.00', unit: 'pieces', unitPrice: 500 }],
    })
    // A future table/sequence/trigger proves new objects cannot silently disappear.
    await source.query(`CREATE TABLE future_backup_probe(id SERIAL PRIMARY KEY,value INTEGER NOT NULL);
      CREATE FUNCTION future_probe_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.value=NEW.value+1; RETURN NEW; END $$;
      CREATE TRIGGER future_probe_guard BEFORE INSERT ON future_backup_probe FOR EACH ROW EXECUTE FUNCTION future_probe_guard();
      INSERT INTO future_backup_probe(value) VALUES(4)`)
    const before = await snapshot(source)
    for (const table of ['register_cash_withdrawals','register_cash_entries','register_cash_operations','integration_keys','stock_reservations','stock_reservation_lines','stock_reservation_operations']) assert.ok(before[table].rows > 0, `${table} is populated in the drill`)
    const backup = await createPostgresBackup({ env })
    assert.equal(backup.contents.tables, Object.keys(before).length)
    assert.ok(backup.contents.tables >= 23, 'Every application table is included')
    assert.ok(backup.contents.functions >= 5)
    assert.ok(backup.contents.triggers >= 10)
    for (const filename of [backup.file, `${backup.file}.sha256`, `${backup.file}.manifest.json`]) assert.equal((await fs.stat(filename)).mode & 0o777, 0o600)
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700)
    const restored = await restorePostgresBackup({ archive: backup.file, env })
    assert.equal(restored.tables, Object.keys(before).length)
    assert.equal(restored.invalidatedSessions, 1)
    target = new pg.Pool(postgresConfig(targetUrl.href))
    const after = await snapshot(target)
    delete before.auth_sessions
    const sessions = after.auth_sessions
    delete after.auth_sessions
    assert.deepEqual(after, before, 'Every table retains exact data; credential values never appear in assertion output')
    assert.equal(sessions.rows, 0, 'Restoring a database cannot resurrect staff login sessions')
    assert.equal((await createIntegrationStore({ pool: target }).authenticate(tokenDigest(issued.token), 'test')).id, issued.client.id,
      'Restored integration credentials retain their original authentication behavior')
    await assert.rejects(target.query('DELETE FROM items WHERE id=$1', [itemId]), { code: '23514' }, 'Restored reservation protection triggers are active')
    assert.deepEqual((await target.query('INSERT INTO future_backup_probe(value) VALUES(8) RETURNING id,value')).rows[0], { id: 2, value: 9 }, 'Restored sequences and procedural triggers remain functional')
    await target.end(); target = null
    await assert.rejects(restorePostgresBackup({ archive: backup.file, env }), /must be empty/)
    await assert.rejects(restorePostgresBackup({ archive: backup.file, env: { ...env, RESTORE_DATABASE_URL: sourceUrl.href, RESTORE_CONFIRM_DATABASE: sourceName } }), /distinct from the source/)
    const second = await createPostgresBackup({ env })
    assert.notEqual(second.file, backup.file)
    assert.equal((await fs.stat(backup.file)).size, backup.bytes, 'Subsequent backups preserve previous archives')
    await fs.appendFile(second.file, Buffer.from('corrupt'))
    await assert.rejects(restorePostgresBackup({ archive: second.file, env }), /integrity verification failed/)
    await assert.rejects(createPostgresBackup({ env: { ...env, BACKUP_DIRECTORY: path.resolve('backups') } }), /outside the application checkout/)
    const brokenTool = path.join(directory, 'broken-pg-dump')
    await fs.writeFile(brokenTool, '#!/bin/sh\nprintf "%s" "$PGPASSWORD" >&2\nexit 1\n', { mode: 0o700 })
    const filesBeforeFailure = (await fs.readdir(directory)).sort()
    await assert.rejects(createPostgresBackup({ env: { ...env, PG_DUMP_PATH: brokenTool, PGPASSWORD: 'never-print-this-secret' } }), error => !error.message.includes('never-print-this-secret') && /failed/.test(error.message))
    assert.deepEqual((await fs.readdir(directory)).sort(), filesBeforeFailure, 'Failed backups do not leave incomplete archives or delete older backups')

    // Orchestration-only doubles: no cloud credentials, encryption keys, network
    // traffic or claims about age cryptography enter this test.
    const ageDouble = path.join(directory, 'age-double')
    const remoteDouble = path.join(directory, 'rclone-double')
    const commandLog = path.join(directory, 'commands.jsonl')
    const remoteDirectory = path.join(directory, 'remote')
    await fs.mkdir(remoteDirectory, { mode: 0o700 })
    await fs.writeFile(ageDouble, `#!/usr/bin/env node
let input=''; for await(const chunk of process.stdin)input+=chunk.toString('base64'); process.stdout.write('AGE-TEST:'+input);
`, { mode: 0o700 })
    await fs.writeFile(remoteDouble, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);
fs.appendFileSync(process.env.BACKUP_TEST_COMMAND_LOG,JSON.stringify(args)+'\\n');
if(args[0]==='copyto') {if(!args[1].endsWith('.tar.age')||!args.includes('--immutable'))process.exit(2); fs.copyFileSync(args[1],path.join(process.env.BACKUP_TEST_REMOTE_DIRECTORY,path.basename(args[1])),fs.constants.COPYFILE_EXCL);}
else if(args[0]==='check') {if(process.env.BACKUP_TEST_VERIFY_FAILURE==='true')process.exit(1); const filename=args[args.indexOf('--include')+1].slice(1);if(!fs.readFileSync(path.join(args[1],filename)).equals(fs.readFileSync(path.join(process.env.BACKUP_TEST_REMOTE_DIRECTORY,filename))))process.exit(3);}
else process.exit(4);
`, { mode: 0o700 })
    const offsiteEnv = { ...env, AGE_PATH: ageDouble, RCLONE_PATH: remoteDouble, BACKUP_AGE_RECIPIENT: 'age1public-test-recipient',
      BACKUP_REMOTE: 'fixture:backups', BACKUP_TEST_COMMAND_LOG: commandLog, BACKUP_TEST_REMOTE_DIRECTORY: remoteDirectory }
    const uploaded = await shellWorkflow(offsiteEnv)
    assert.equal(uploaded.code, 0, uploaded.output)
    assert.match(uploaded.output, /uploaded and verified/)
    const uploadedFiles = await fs.readdir(remoteDirectory)
    assert.equal(uploadedFiles.length, 1)
    assert.ok(uploadedFiles[0].endsWith('.tar.age'), 'Only the encryption program output is uploaded')
    const commands = (await fs.readFile(commandLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(commands.map(args => args[0]), ['copyto','check'])
    assert.ok(commands[1].includes('--download'))
    const verificationFailure = await shellWorkflow({ ...offsiteEnv, BACKUP_TEST_VERIFY_FAILURE: 'true' })
    assert.equal(verificationFailure.code, 1)
    assert.match(verificationFailure.output, /verification failed/)
    assert.doesNotMatch(verificationFailure.output, /uploaded and verified/)
    const rejectedRemote = await shellWorkflow({ ...offsiteEnv, BACKUP_REMOTE: 'https://user:never-print-this-secret@storage.example/bucket' })
    assert.equal(rejectedRemote.code, 1)
    assert.doesNotMatch(rejectedRemote.output, /never-print-this-secret/)
  } finally {
    await target?.end().catch(() => {})
    await source.end()
    await admin.query(`DROP DATABASE IF EXISTS ${quote(targetName)} WITH (FORCE)`).catch(() => {})
    await admin.query(`DROP DATABASE IF EXISTS ${quote(sourceName)} WITH (FORCE)`).catch(() => {})
    await admin.end().catch(() => {})
    await fs.rm(directory, { recursive: true, force: true })
  }
})
