import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import pg from 'pg'
import { postgresConfig } from './postgres.js'

const key=()=>crypto.randomUUID()
for(const postgres of [false,true])test(`HTTP refund retries survive lost success without another payout (${postgres?'PostgreSQL':'JSON'})`,{skip:postgres&&!process.env.TEST_DATABASE_URL,timeout:30000},async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bakery-refund-http-')),schema='verify_refund_http_'+key().replaceAll('-','')
  const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!/^(DATABASE_|MIGRATION_|TEST_DATABASE|RAILWAY_|STAFF_PIN|APP_USERNAME|APP_PASSWORD|SESSION_SECRET|MERCADOPAGO_|INVENTORY_|POINT_|PGOPTIONS|PGSERVICE|PGHOST|PGPORT|PGDATABASE|PGUSER|PGPASSWORD)/.test(name)))
  Object.assign(env,{NODE_ENV:'test',PORT:'0',DATA_PATH:path.join(directory,'data.json'),SEED_DEMO_DATA:'false',SESSION_SECRET:crypto.randomBytes(32).toString('hex'),MERCADOPAGO_MOCK:'true'})
  let admin,child,dropper
  try{
    if(postgres){admin=new pg.Client(postgresConfig(process.env.TEST_DATABASE_URL));await admin.connect();await admin.query(`CREATE SCHEMA "${schema}"`);const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);env.DATABASE_URL=url.href}
    let logs=''
    child=spawn(process.execPath,['server/index.js'],{cwd:process.cwd(),env,stdio:['ignore','pipe','pipe']})
    child.stderr.on('data',value=>{logs+=value});child.stdout.on('data',value=>{logs+=value})
    const port=await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('Local refund fixture startup timed out: '+logs)),10000)
      child.once('exit',()=>{clearTimeout(timeout);reject(new Error('Local refund fixture exited: '+logs))})
      child.stdout.on('data',()=>{const match=/listening on port (\d+)/.exec(logs);if(match){clearTimeout(timeout);resolve(match[1])}})
    })
    const base=`http://127.0.0.1:${port}`
    let cookie=''
    const request=async(route,method='GET',body,operation=null,target=base)=>{
      const response=await fetch(target+route,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(operation?{'Idempotency-Key':operation}:{})},body:body===undefined?undefined:JSON.stringify(body)})
      if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0]
      return{status:response.status,body:await response.json()}
    }
    const okay=async(...args)=>{const result=await request(...args);assert.ok(result.status>=200&&result.status<300,JSON.stringify(result));return result.body}
    await okay('/api/auth/setup','POST',{username:'refund-fixture',name:'Refund fixture',password:crypto.randomBytes(24).toString('hex')})
    let session=await okay('/api/register-sessions','POST',{openingCash:0})
    const item=await okay('/api/items','POST',{name:'Refund fixture bread',category:'Bread',unit:'pieces',quantity:10,price:1000,sellable:true,lowStockThreshold:0})
    const sell=method=>okay('/api/sales/'+method,'POST',{items:[{itemId:item.id,quantity:1}],...(method==='cash'?{cashReceived:1000}:{})},key())
    const sale=await sell('cash'),operation=key(),body={amount:400,items:[{lineId:sale.items[0].lineId,quantity:1}],restock:true,reason:'Lost-response fixture'}
    assert.equal((await request(`/api/sales/${sale.id}/refunds`,'POST',body)).status,400)
    assert.equal((await request(`/api/sales/${sale.id}/refunds`,'POST',body,'invalid')).status,400)
    assert.equal((await okay(`/api/sales/${sale.id}`)).refunds.length,0)
    // Discard the entire downstream response after the upstream commit. The
    // browser sees a network error and has only its frozen request/key to retry.
    dropper=http.createServer(async(req,res)=>{
      try{
        const chunks=[];for await(const chunk of req)chunks.push(chunk)
        const result=await fetch(base+req.url,{method:req.method,headers:{'Content-Type':'application/json',Cookie:cookie,'Idempotency-Key':req.headers['idempotency-key']},body:Buffer.concat(chunks)})
        await result.arrayBuffer();res.destroy()
      }catch{res.destroy()}
    })
    dropper.listen(0,'127.0.0.1');await once(dropper,'listening')
    const broken=`http://127.0.0.1:${dropper.address().port}`
    await assert.rejects(request(`/api/sales/${sale.id}/refunds`,'POST',body,operation,broken),/fetch failed|socket|network/i)
    const committed=await okay(`/api/sales/${sale.id}`)
    assert.equal(committed.refundedTotal,400);assert.equal(committed.refunds.length,1)
    const refundId=committed.refunds[0].id
    assert.equal(committed.refunds[0].requestKey,operation);assert.equal(committed.refunds[0].providerFull,false)
    for(const replay of await Promise.all(Array.from({length:4},()=>request(`/api/sales/${sale.id}/refunds`,'POST',body,operation)))){
      assert.equal(replay.status,200);assert.equal(replay.body.refunds[0].id,refundId);assert.equal(replay.body.refundedTotal,400)
    }
    assert.equal((await okay('/api/register-cash')).balance,600)
    assert.equal((await okay('/api/items')).find(i=>i.id===item.id).quantity,10)
    assert.equal((await request(`/api/sales/${sale.id}/refunds`,'POST',{...body,amount:401},operation)).body.code,'IDEMPOTENCY_CONFLICT')
    const second=await sell('cash')
    assert.equal((await request(`/api/sales/${second.id}/refunds`,'POST',body,operation)).body.code,'IDEMPOTENCY_CONFLICT')
    const balance=(await okay('/api/register-cash')).balance,work=await okay(`/api/register-sessions/${session.id}/closure`)
    await okay(`/api/register-sessions/${session.id}/closure`,'POST',{cashIn:0,cashOut:0,countedCash:balance,note:'Local refund verification',expectedRevision:0,fingerprint:work.live.fingerprint})
    assert.equal((await request(`/api/sales/${sale.id}/refunds`,'POST',body,operation)).status,200,'A processed replay must not require a new paying session')
    session=await okay('/api/register-sessions','POST',{})

    const card=await sell('card')
    if(postgres)await admin.query(`UPDATE "${schema}".sales SET created_at=NOW()-INTERVAL '5 seconds' WHERE id=$1`,[card.id])
    else{const data=JSON.parse(await fs.readFile(env.DATA_PATH,'utf8'));data.sales.find(s=>s.id===card.id).createdAt=new Date(Date.now()-5000).toISOString();await fs.writeFile(env.DATA_PATH,JSON.stringify(data))}
    assert.equal((await okay(`/api/sales/${card.id}?refresh=true`)).status,'paid')
    const cardOperation=key(),cardBody={amount:400,items:[],restock:false}
    await assert.rejects(request(`/api/sales/${card.id}/refunds`,'POST',cardBody,cardOperation,broken),/fetch failed|socket|network/i)
    const cardReplay=await request(`/api/sales/${card.id}/refunds`,'POST',cardBody,cardOperation)
    assert.equal(cardReplay.status,200);assert.equal(cardReplay.body.refundedTotal,400);assert.equal(cardReplay.body.refunds.length,1)
    assert.equal(cardReplay.body.refunds[0].requestKey,cardOperation)

    const cashBalance=(await okay('/api/register-cash')).balance
    await okay('/api/register-cash/withdrawals','POST',{sessionId:session.id,amount:cashBalance,recipient:'Local fixture',purpose:'Insufficient cash test'},key())
    const failedKey=key(),failedBody={amount:500,items:[],restock:false}
    const failed=await request(`/api/sales/${sale.id}/refunds`,'POST',failedBody,failedKey)
    assert.equal(failed.status,409);assert.equal(failed.body.code,'INSUFFICIENT_CASH')
    await sell('cash')
    const failedReplay=await request(`/api/sales/${sale.id}/refunds`,'POST',failedBody,failedKey)
    assert.equal(failedReplay.status,200)
    assert.equal(failedReplay.body.refunds.find(r=>r.requestKey===failedKey).status,'failed')
    assert.equal(failedReplay.body.refundedTotal,400);assert.equal((await okay('/api/register-cash')).balance,1000)
  }finally{
    if(dropper){dropper.closeAllConnections();await new Promise(resolve=>dropper.close(resolve))}
    if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill();await exited}
    if(admin){await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end()}
    await fs.rm(directory,{recursive:true,force:true})
  }
})
