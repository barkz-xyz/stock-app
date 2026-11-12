import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { once } from 'node:events'
import pg from 'pg'
import express from 'express'
import { createInventoryRouter } from '../server/inventory-api.js'

// Local fixtures only; this command never accepts DATABASE_URL or a remote host.
const label = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'current'
assert.match(label, /^[a-zA-Z0-9_-]+$/)
const uncached = process.argv.includes('--uncached')
const baseDb = process.env.TEST_DATABASE_URL
assert.ok(baseDb, 'TEST_DATABASE_URL is required (local test database only)')
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseDb).hostname), 'Only a loopback PostgreSQL fixture is allowed')
const schema = 'measure_inventory_' + crypto.randomUUID().replaceAll('-', '')
const admin = new pg.Client({ connectionString: baseDb, ssl: false }); await admin.connect()
await admin.query(`CREATE SCHEMA "${schema}"`)
const url = new URL(baseDb); url.searchParams.set('options', `-c search_path=${schema}`)
for (const key of Object.keys(process.env)) if (/^(STAFF_PIN$|APP_|SESSION_SECRET$|MERCADOPAGO_|POINT_|RAILWAY_)/.test(key)) delete process.env[key]
process.env.DATABASE_URL = url.href; process.env.PGSSLMODE = 'disable'; process.env.SEED_DEMO_DATA = 'false'
const store = await import('../server/store.js?' + crypto.randomUUID())
let server, db
let queries = [], recording = false
const originalQuery = pg.Client.prototype.query
pg.Client.prototype.query = function (...args) {
  const sql = typeof args[0] === 'string' ? args[0] : args[0].text
  const started = performance.now()
  const record = result => {
    if (!recording) return
    const rows = result?.rows || []
    const inventoryRows = /FROM items\b/i.test(sql) ? (Array.isArray(rows[0]?.items) ? rows[0].items.length : rows[0]?.name ? rows.length : 0) : 0
    queries.push({ sql, inventoryRows, bytes: Buffer.byteLength(JSON.stringify(rows)), ms: performance.now() - started })
  }
  const last = args.length-1
  if (typeof args[last] === 'function') { const cb = args[last]; args[last] = (err,result) => { record(result); cb(err,result) }; return originalQuery.apply(this,args) }
  return originalQuery.apply(this,args).then(result => { record(result); return result })
}
const report = { label, uncached, products: 49, postgres: (await admin.query('SHOW server_version')).rows[0].server_version, samples: {} }
const summary = () => ({ sql: queries.length, inventoryStatements: queries.filter(q=>/FROM items\b/i.test(q.sql)).length, inventoryRows: queries.reduce((sum,q)=>sum+q.inventoryRows,0), dbResultBytes: queries.reduce((s,q)=>s+q.bytes,0) })
try {
  await store.initializeStore()
  db = new pg.Pool({ connectionString: url.href, ssl:false })
  await db.query(`INSERT INTO items(id,name,category,unit,quantity,price,sellable) SELECT gen_random_uuid(),'Pan '||lpad(n::text,2,'0'),'Bread','kg',12.25,1200,TRUE FROM generate_series(1,49) n`)
  const itemId = (await store.listItems())[0].id
  const integrations = store.getInventoryIntegrationStore(); await integrations.initialize()
  if (uncached) integrations.readInventorySnapshot = undefined
  const issued = await integrations.createClient({ name: 'Local benchmark', environment:'test', expiresInDays:1 })
  const app = express()
  app.use('/api/integrations/v1', createInventoryRouter({ getStore: () => integrations, config: { enabled: true, environment: 'test' } }))
  app.get('/api/bootstrap', async (_req, res) => res.json(await store.getBootstrapData()))
  server = app.listen(0,'127.0.0.1'); await once(server,'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const read = async (route,etag) => { queries=[]; recording=true; const started=performance.now();const r=await fetch(base+route,{headers:{Authorization:`Bearer ${issued.token}`,...etag?{'If-None-Match':etag}:{} }});const body=await r.text();recording=false;return {status:r.status,ms:performance.now()-started,bytes:Buffer.byteLength(body),etag:r.headers.get('etag'),...summary()} }
  report.samples.bootstrap = await read('/api/bootstrap')
  report.samples.apiCold = await read('/api/integrations/v1/inventory')
  const timings=[]
  for(let i=0;i<7;i++) timings.push(await read('/api/integrations/v1/inventory',report.samples.apiCold.etag))
  report.samples.apiUnchanged = {...timings[6],medianMs:timings.map(x=>x.ms).sort((a,b)=>a-b)[3]}
  await db.query('UPDATE items SET quantity=quantity-0.25,updated_at=NOW() WHERE id=$1',[itemId])
  report.samples.apiChanged = await read('/api/integrations/v1/inventory',report.samples.apiCold.etag)
  await db.end();db=null
  await fs.mkdir('output',{recursive:true});await fs.writeFile(`output/inventory-${label}.json`,JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify(report,null,2))
} finally {
  pg.Client.prototype.query = originalQuery
  if (server) {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  await store.closeStore()
  await db?.end()
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
  await admin.end()
}
