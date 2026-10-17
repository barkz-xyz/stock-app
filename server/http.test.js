import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import crypto from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

test('HTTP authentication rejects malformed sessions and validates product calendar dates', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bakery-http-'))
  const secret = crypto.randomBytes(32).toString('hex')
  const env = { ...process.env, PORT: '0', DATA_PATH: path.join(directory, 'inventory.json'),
    STAFF_PIN: '7351', SESSION_SECRET: secret, SEED_DEMO_DATA: 'false', MERCADOPAGO_MOCK: 'false' }
  delete env.DATABASE_URL
  delete env.MERCADOPAGO_ACCESS_TOKEN
  delete env.MERCADOPAGO_POINT_TERMINAL_ID
  const pendingId = crypto.randomUUID()
  await fs.writeFile(env.DATA_PATH, JSON.stringify({ items: [], movements: [], cashClosures: [], sales: [{
    id: pendingId, status: 'pending', paymentMethod: 'card', total: 1000, mpOrderId: `DEMO-${pendingId}`,
    inventoryApplied: true, items: [], refunds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }] }))
  for (const key of Object.keys(env)) if (key.startsWith('RAILWAY_')) delete env[key]
  const child = spawn(process.execPath, ['server/index.js'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  child.stderr.on('data', (chunk) => { logs += chunk })
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
    await fs.rm(directory, { recursive: true, force: true })
  })
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${logs}`)), 10000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Server exited: ${logs}`)) })
    child.stdout.on('data', (chunk) => {
      logs += chunk
      const match = /listening on port (\d+)/.exec(logs)
      if (match) { clearTimeout(timer); resolve(Number(match[1])) }
    })
  })
  const base = `http://127.0.0.1:${port}`
  const request = (route, options = {}) => fetch(`${base}${route}`, options)
  assert.equal((await request('/api/items', { headers: { Cookie: 'bakery_session=%' } })).status, 401)
  assert.equal((await request('/api/auth/status', { headers: { Cookie: 'a=%ZZ' } })).status, 200)
  const signedCookie = (expiry) => `bakery_session=${expiry}.${crypto.createHmac('sha256', secret).update(expiry).digest('base64url')}`
  assert.equal((await request('/api/items', { headers: { Cookie: signedCookie('NaN') } })).status, 401)
  assert.equal((await request('/api/items', { headers: { Cookie: signedCookie('1') } })).status, 401)
  const login = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '7351' }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const pending = await request(`/api/sales/${pendingId}?refresh=true`, { headers: { Cookie: cookie } })
  assert.equal(pending.status, 200)
  assert.equal((await pending.json()).status, 'pending')
  assert.equal((await request('/api/items', { headers: { Cookie: `a=%ZZ; ${cookie}` } })).status, 200)
  const product = { name: 'Calendar test', category: 'Bread', unit: 'pieces', quantity: 3, price: 1000, sellable: true }
  for (const expiryDate of ['not-a-date', '2026-02-30', '2026-13-01', '2026-10-17garbage', true]) {
    const response = await request('/api/items', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...product, expiryDate }) })
    assert.equal(response.status, 400, `Rejected invalid expiry date: ${expiryDate}`)
  }
  assert.equal((await (await request('/api/items', { headers: { Cookie: cookie } })).json()).length, 0)
  assert.equal((await request('/api/items', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...product, expiryDate: '2028-02-29' }) })).status, 201)
  for (let attempt = 0; attempt < 9; attempt++) {
    const response = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `192.0.2.${attempt}` }, body: JSON.stringify({ pin: 'wrong' }) })
    assert.equal(response.status, attempt < 8 ? 401 : 429)
  }
})

test('staff authentication requires an independent session secret', async () => {
  await assert.rejects(promisify(execFile)(process.execPath, ['--input-type=module', '-e', "await import('./server/auth.js')"], {
    env: { ...process.env, STAFF_PIN: '7351', SESSION_SECRET: '' }, windowsHide: true,
  }), (error) => error.stderr.includes('SESSION_SECRET is required'))
})
