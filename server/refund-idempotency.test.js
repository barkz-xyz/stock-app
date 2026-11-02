import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import pg from 'pg'
import { postgresConfig } from './postgres.js'

const key=()=>crypto.randomUUID()
for(const postgres of [false,true])test(`refund requests preserve their identity and provider payload (${postgres?'PostgreSQL':'JSON'})`,{skip:postgres&&!process.env.TEST_DATABASE_URL},async()=>{
  const previous={DATABASE_URL:process.env.DATABASE_URL,DATA_PATH:process.env.DATA_PATH}
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bakery-refund-key-')),schema='verify_refund_key_'+key().replaceAll('-','')
  let admin,store
  try{
    if(postgres){admin=new pg.Client(postgresConfig(process.env.TEST_DATABASE_URL));await admin.connect();await admin.query(`CREATE SCHEMA "${schema}"`);const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);process.env.DATABASE_URL=url.href}
    else delete process.env.DATABASE_URL
    process.env.DATA_PATH=path.join(directory,'data.json')
    store=await import(`./store.js?refund-key=${key()}`);await store.initializeStore()
    const user=await store.createUser({username:'refund-'+key().slice(0,8),name:'Refund fixture',role:'admin',password:'Local-Fixture-2026'})
    const other=await store.createUser({username:'refund-'+key().slice(0,8),name:'Other fixture',role:'admin',password:'Local-Fixture-2026'})
    const session=await store.openRegisterSession(user,1000),actor={...user,sessionId:session.id}
    const product=await store.createItem({name:'Bread',category:'Bread',unit:'pieces',quantity:10,price:1000,sellable:true,lowStockThreshold:0,sku:'',expiryDate:null})
    const sale=await store.createSale([{itemId:product.id,quantity:1}],'cash',key(),1000,actor)
    const operation=key(),body={amount:500,items:[],reason:'Refund fixture',restock:false,creditNoteRequired:false,originalDocumentType:'',originalFolio:''}
    const prepared=await Promise.all(Array.from({length:5},()=>store.prepareRefund(sale.id,body,{key:operation,actor:user})))
    assert.equal(new Set(prepared.map(r=>r.refund.id)).size,1);assert.equal(prepared.filter(r=>!r.replayed).length,1)
    assert.ok(prepared.every(r=>r.full===false&&r.refund.providerFull===false&&r.refund.requestKey===operation))
    const refundId=prepared[0].refund.id
    await Promise.all(prepared.map(()=>store.completeRefund(refundId,null,actor)))
    const replay=await store.prepareRefund(sale.id,body,{key:operation,actor:user})
    assert.equal(replay.replayed,true);assert.equal(replay.refund.status,'processed');assert.equal(replay.sale.refundedTotal,500)
    assert.equal((await store.getRegisterCashStore().workspace(user)).entries.filter(e=>e.refundId===refundId).length,1)
    await assert.rejects(store.prepareRefund(sale.id,{...body,amount:501},{key:operation,actor:user}),{code:'IDEMPOTENCY_CONFLICT'})
    await assert.rejects(store.prepareRefund(sale.id,body,{key:operation,actor:other}),{code:'IDEMPOTENCY_CONFLICT'})
    const secondSale=await store.createSale([{itemId:product.id,quantity:1}],'cash',key(),1000,actor)
    await assert.rejects(store.prepareRefund(secondSale.id,body,{key:operation,actor:user}),{code:'IDEMPOTENCY_CONFLICT'})

    const card=await store.createSale([{itemId:product.id,quantity:1}],'card',key(),null,actor)
    const order={id:'LOCAL-'+key(),status:'processed',status_detail:'accredited',external_reference:card.mpExternalReference,transactions:{payments:[{id:'PAY-'+key(),status:'processed',status_detail:'accredited'}]}}
    await store.attachPointOrder(card.id,order);const paid=await store.updateSaleFromPoint(order)
    const cardKey=key(),partial={...body,amount:800}
    const original=await store.prepareRefund(paid.id,partial,{key:cardKey,actor:user})
    assert.equal(original.full,false)
    await store.updateSaleFromPoint({...order,status_detail:'partially_refunded',transactions:{...order.transactions,refunds:[{id:'EXTERNAL-'+key(),amount:'200',status:'processed'}]}})
    const current=await store.getSale(paid.id);assert.equal(current.refundedTotal,200)
    const saved=await store.prepareRefund(paid.id,partial,{key:cardKey,actor:user})
    assert.equal(saved.replayed,true);assert.equal(saved.full,false);assert.equal(saved.refund.providerFull,false)
    assert.equal(saved.refund.id,original.refund.id)
  }finally{
    await store?.closeStore()
    if(admin){await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end()}
    for(const[name,value]of Object.entries(previous))value===undefined?delete process.env[name]:process.env[name]=value
    await fs.rm(directory,{recursive:true,force:true})
  }
})
