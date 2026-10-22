import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import pg from 'pg'
import express from 'express'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { createInventoryRouter } from '../server/inventory-api.js'

// Local fixtures only; this command never accepts DATABASE_URL or a remote host.
const label = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'current'
assert.match(label, /^[a-zA-Z0-9_-]+$/)
const withUi = process.argv.includes('--ui')
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
let vite, server, browser, db
let queries = [], recording = false, requests = []
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
  const user = {id:crypto.randomUUID(),name:'Local admin',username:'admin',role:'admin',mustChangePassword:false,active:true}
  const auth = {required:true,authenticated:true,user,productionReady:true,setupRequired:false}
  const session = {id:crypto.randomUUID(),userId:user.id,operator:user.name,openingCash:10000,openedAt:new Date().toISOString(),closedAt:null}
  const app = express()
  app.use((req,res,next)=>{requests.push(req.path);res.set('Cache-Control','private, no-store');next()})
  app.use('/api/integrations/v1',createInventoryRouter({getStore:()=>integrations,config:{enabled:true,environment:'test'}}))
  app.get('/api/sales/history',async(req,res)=>res.json(await store.searchSales(req.query,user)))
  app.get('/api/cash-closures',async(req,res)=>res.json(await store.getCashClosureWorkspace(req.query.date)))
  app.get('/api/bootstrap',async(_req,res)=>res.json({auth,...await store.getBootstrapData(),registerSessions:[session],registerSession:session,posConfig:{configured:false,mockMode:false,terminalLabel:''}}))
  if (withUi) {
  vite = await createServer({ configFile:false, envFile:false, plugins:[{name:'local-render-counts',enforce:'pre',transform(code,id){if(!/\/src\/(App|SalesCounter)\.jsx$/.test(id.replaceAll('\\','/')))return; return code.replace(/function (Dashboard|Inventory|InventoryList|Activity|SalesCounter|ProductArtwork)\(([^\n]*)\) \{/g,(m,name)=>m+` globalThis.__renders ||= {}; globalThis.__renders.${name} = (globalThis.__renders.${name} || 0) + 1;`) }},react()],server:{middlewareMode:true,hmr:false,ws:false},appType:'spa' })
  app.use(vite.middlewares)
  }
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
  if (withUi) {
  const profile = path.resolve('tmp', `chrome-inventory-${crypto.randomUUID()}`)
  browser = spawn(process.env.CHROME_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--disable-extensions','--disable-background-networking','--disable-component-update','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,'--remote-debugging-port=0','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']})
  const endpoint = await new Promise((resolve,reject)=>{let s='';const timer=setTimeout(()=>reject(Error('Chrome startup timed out')),15000);browser.stderr.on('data',b=>{s+=b;const m=s.match(/DevTools listening on (ws:\/\/\S+)/);if(m){clearTimeout(timer);resolve(m[1])}})})
  const socket = new WebSocket(endpoint); await once(socket,'open'); let seq=0; const pending=new Map()
  socket.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}})
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq;const timeout=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method))},15000);pending.set(id,{resolve:result=>{clearTimeout(timeout);resolve(result)},reject:error=>{clearTimeout(timeout);reject(error)}});socket.send(JSON.stringify({id,method,params,...sessionId?{sessionId}:{}}))})
  const target=await send('Target.createTarget',{url:'about:blank'}); const {sessionId}=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true})
  const cdp=(method,params)=>send(method,params,sessionId)
  const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value}
  await cdp('Page.enable'); await cdp('Runtime.enable')
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`globalThis.__sources=[];globalThis.__reconcile=[];const nativeTimeout=globalThis.setTimeout;globalThis.setTimeout=(cb,ms,...args)=>{if(ms===60000||ms===15000){__reconcile.push(cb);return -1}return nativeTimeout(cb,ms,...args)};globalThis.EventSource=class extends EventTarget{constructor(){super();__sources.push(this);nativeTimeout(()=>this.dispatchEvent(new Event('ready')),0)}close(){}};localStorage.setItem('bakery-language','es');`})
  const wait=async expr=>{for(let i=0;i<200;i++){if(await evaluate(`Boolean(${expr})`))return;await new Promise(r=>setTimeout(r,50))}throw Error('UI timeout: '+expr)}
  requests=[]
  await cdp('Page.navigate',{url:base+'/caja'})
  await wait("document.querySelectorAll('.sale-product').length===49 && document.querySelector('.server-chip:not(:disabled)')")
  await new Promise(r=>setTimeout(r,200))
  report.ui={initialBootstrapRequests:requests.filter(p=>p==='/api/bootstrap').length}
  await evaluate("document.querySelector('.sale-product').click();document.querySelector('.search-box input').focus();document.querySelector('.search-box input').setSelectionRange(0,0)")
  const measureUi=async(trigger)=>{await evaluate('globalThis.__renders={}');requests=[];await evaluate(trigger);await wait("Boolean(document.querySelector('.server-chip:not(:disabled)'))");await new Promise(r=>setTimeout(r,150));return {renders:await evaluate('__renders'),bootstrapRequests:requests.filter(p=>p==='/api/bootstrap').length,focus:await evaluate("document.activeElement===document.querySelector('.search-box input')"),cart:await evaluate("document.querySelector('.cart-count')?.textContent"),scrollY:await evaluate('window.scrollY')} }
  report.ui.manualUnchanged=await measureUi("document.querySelector('.server-chip').click()")
  report.ui.sseUnchanged=await measureUi("__sources.at(-1).dispatchEvent(new Event('change'))")
  report.ui.periodicUnchanged=await measureUi("__reconcile.at(-1)()")
  await db.query('UPDATE items SET quantity=quantity-0.25,updated_at=NOW() WHERE id=$1',[itemId])
  report.ui.sseChanged=await measureUi("__sources.at(-1).dispatchEvent(new Event('change'))")
  await evaluate("document.querySelector('#caja-history-tab').click()")
  await wait("document.querySelector('.history-ledger:not(.is-updating)')")
  requests=[]
  await evaluate("__sources.at(-1).dispatchEvent(new Event('change'))")
  await wait("document.querySelector('.history-ledger:not(.is-updating)')")
  await new Promise(r=>setTimeout(r,250))
  report.ui.historyReconcilesIdenticalBootstrap=requests.includes('/api/sales/history')
  assert.equal(report.ui.historyReconcilesIdenticalBootstrap,true)
  await cdp('Page.navigate',{url:base+'/caja/cierre'})
  await wait("document.querySelector('.closure-operations')")
  await new Promise(r=>setTimeout(r,250)); requests=[]
  await evaluate("__sources.at(-1).dispatchEvent(new Event('change'))")
  await new Promise(r=>setTimeout(r,250))
  report.ui.closureReconcilesIdenticalBootstrap=requests.includes('/api/cash-closures')
  assert.equal(report.ui.closureReconcilesIdenticalBootstrap,true)
  await cdp('Page.navigate',{url:base+'/inventario'})
  await wait("document.querySelectorAll('.inventory-row').length===49 && document.querySelector('.server-chip:not(:disabled)')")
  await evaluate("document.querySelector('.search-box input').focus();window.scrollTo(0,400)")
  report.ui.inventoryUnchanged=await measureUi("document.querySelector('.server-chip').click()")
  assert.equal(report.ui.sseUnchanged.focus, true); assert.equal(report.ui.sseUnchanged.cart, '1')
  assert.equal(report.ui.inventoryUnchanged.focus, true); assert.equal(report.ui.inventoryUnchanged.scrollY, 400)
  socket.close();browser.kill()
  }
  await db.end();db=null
  await fs.mkdir('output',{recursive:true});await fs.writeFile(`output/inventory-${label}.json`,JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify(report,null,2))
} finally {
  pg.Client.prototype.query = originalQuery
  browser?.kill();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await vite?.close();await store.closeStore();await db?.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()
}
