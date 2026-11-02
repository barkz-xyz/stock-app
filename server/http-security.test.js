import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'

test('compressed JSON requests are rejected before inflation and ordinary requests continue working', { timeout: 15000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bakery-http-security-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DATABASE_|TEST_DATABASE|MIGRATION_|RUNTIME_DATABASE_|PROVISION_|BACKUP_|RESTORE_|RAILWAY_|STAFF_PIN$|APP_USERNAME$|APP_PASSWORD$|SESSION_SECRET$|MERCADOPAGO_|INVENTORY_|POINT_)/.test(key)))
  Object.assign(env, {
    NODE_ENV: 'test', PORT: '0', DATA_PATH: path.join(directory, 'data.json'), SEED_DEMO_DATA: 'false',
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'), MERCADOPAGO_MOCK: 'false',
  })
  const child = spawn(process.execPath, ['server/index.js'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  child.stderr.on('data', (chunk) => { logs += chunk })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill(); await exited
    }
    await fs.rm(directory, { recursive: true, force: true })
  })
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Local app startup timeout: ${logs}`)), 10000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Local app exited: ${logs}`)) })
    child.stdout.on('data', (chunk) => {
      logs += chunk
      const match = /listening on port (\d+)/.exec(logs)
      if (match) { clearTimeout(timer); resolve(Number(match[1])) }
    })
  })
  const base = `http://127.0.0.1:${port}`
  const credentials = { username: 'http-security', name: 'HTTP Security', password: crypto.randomBytes(24).toString('hex') }
  const body = JSON.stringify(credentials)
  for (const [encoding, compress] of [['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]]) {
    const rejected = await fetch(`${base}/api/auth/setup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': encoding }, body: compress(Buffer.from(body)),
    })
    assert.equal(rejected.status, 415, encoding)
    assert.equal(typeof (await rejected.json()).error, 'string')
    const health = await fetch(`${base}/api/health`)
    assert.equal(health.status, 200); assert.equal((await health.json()).ok, true)
    assert.equal(child.exitCode, null)
  }
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  })
  assert.equal(setup.status, 200, 'Rejected compressed setup requests must not create an administrator')
  assert.ok(setup.headers.get('set-cookie'))
  assert.equal((await setup.json()).user.username, credentials.username)
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: credentials.username, password: credentials.password }),
  })
  assert.equal(login.status, 200); assert.equal((await login.json()).user.username, credentials.username)
})
