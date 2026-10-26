import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import pg from 'pg'
import { PDFDocument } from 'pdf-lib'
import { cashAmount, cleanSettlement } from './cash-ledger.js'
import { createCashClosurePdf } from './cash-closure-pdf.js'
import { readInventorySnapshot } from './inventory-snapshot.js'
import { inventoryRepresentation } from './inventory-api.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { deploymentTestEnvironment } from '../scripts/test-deploy.js'

const key=()=>crypto.randomUUID()
test('cash declarations require integer pesos and a traceable receipt for expenses',()=>{
  for(const value of [-1,.5,NaN,Infinity,'',null,100000000001])assert.throws(()=>cashAmount(value,'monto'))
  assert.throws(()=>cleanSettlement({sessionId:key(),spentAmount:100,documentType:'boleta',documentNumber:'',supplier:'test',detail:'test'}))
  assert.equal(cleanSettlement({sessionId:key(),spentAmount:0,detail:'No se utilizó'}).documentType,'sin_gasto')
})

for(const postgres of [false,true])test(`cash ledger, carry-over and POS shortfalls persist safely (${postgres?'PostgreSQL':'JSON'})`,{skip:postgres&&!process.env.TEST_DATABASE_URL},async t=>{
  const previous={DATABASE_URL:process.env.DATABASE_URL,DATA_PATH:process.env.DATA_PATH}
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'bakery-cash-'))
  const schema='verify_cash_'+key().replaceAll('-','')
  let admin,db,store
  try{
    if(postgres){
      const ssl=process.env.PGSSLMODE==='disable'||process.env.TEST_DATABASE_URL.includes('railway.internal')?false:{rejectUnauthorized:false}
      admin=new pg.Client({connectionString:process.env.TEST_DATABASE_URL,ssl});await admin.connect();await admin.query(`CREATE SCHEMA "${schema}"`)
      const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);process.env.DATABASE_URL=url.href
      db=new pg.Pool({connectionString:url.href,ssl})
    }else delete process.env.DATABASE_URL
    process.env.DATA_PATH=path.join(temp,'inventory.json')
    store=await import(`./store.js?cash=${key()}`);await store.initializeStore()
    const cash=store.getRegisterCashStore()
    const user=()=>store.createUser({username:'cash.'+key().slice(0,8),name:'Cajero ficticio',role:'cashier',password:'Local-Test-Only-2026'})
    const open=async(amount=1000)=>{const u=await user();const s=await store.openRegisterSession(u,amount);return {u,s,actor:{...u,sessionId:s.id}}}
    const issue=(u,s,amount=100,operation=key())=>cash.issue(u,operation,{sessionId:s.id,amount,recipient:'Compras',purpose:'Insumos ficticios'})
    const settlement=(s,spentAmount=60)=>({sessionId:s.id,spentAmount,documentType:'boleta',documentNumber:'FOLIO-42',supplier:'Proveedor ficticio',detail:'Compra de insumos'})
    const close=async(u,s,countedCash)=>{
      const current=await store.getRegisterClosure(u,s.id)
      return store.saveRegisterClosure(u,s.id,{openingCash:999999,cashIn:0,cashOut:0,countedCash,
        countedCard:current.live.card.net,operator:'ignored',note:'Prueba aislada',expectedRevision:current.closure?.revision||0,fingerprint:current.live.fingerprint})
    }
    const product=(quantity=0,unit='pieces')=>store.createItem({name:'Producto ficticio',category:'Bread',unit,quantity,price:1000,sellable:true,lowStockThreshold:0,sku:'',expiryDate:null})

    await t.test('the last own close supplies opening cash, extra cash is separate and duplicate opening is harmless',async()=>{
      const {u,s}=await open(1200)
      await close(u,s,1200)
      const context=await store.getRegisterOpening(u)
      assert.equal(context.openingCash,1200);assert.equal(context.previousSessionId,s.id)
      await assert.rejects(store.openRegisterSession(u,{...context,previousRevision:999}),{code:'OPENING_CHANGED'})
      const next=await store.openRegisterSession(u,{...context,additionalCash:300})
      assert.equal(next.openingCash,1500);assert.equal(next.additionalCash,300);assert.equal(next.sourceSessionId,s.id)
      assert.equal((await store.openRegisterSession(u,{...context,additionalCash:999})).id,next.id)
      assert.equal((await store.getRegisterOpening(await user())).openingCash,0)
      assert.equal((await cash.workspace(u)).availableCash,1500)
    })
    await t.test('concurrent withdrawals cannot spend the same cash; retries and changed bodies are distinct',async()=>{
      const {u,s}=await open(1000),operation=key(),body={sessionId:s.id,amount:600,recipient:'Producción',purpose:'Ingredientes'}
      const results=await Promise.all(Array.from({length:4},()=>cash.issue(u,operation,body)))
      assert.equal(new Set(results.map(r=>r.withdrawal.id)).size,1);assert.equal(results.filter(r=>!r.replayed).length,1)
      await assert.rejects(cash.issue(u,operation,{...body,amount:601}),{code:'IDEMPOTENCY_CONFLICT'})
      const race=await Promise.allSettled([issue(u,s,300),issue(u,s,300)])
      assert.equal(race.filter(r=>r.status==='fulfilled').length,1)
      assert.equal(race.find(r=>r.status==='rejected').reason.code,'INSUFFICIENT_CASH')
      const workspace=await cash.workspace(u);assert.equal(workspace.availableCash,100);assert.equal(workspace.entries.length,2)
    })
    await t.test('receipt, used amount and returned excess settle once and reject foreign cashiers',async()=>{
      const {u,s}=await open(),w=(await issue(u,s)).withdrawal,k=key()
      await assert.rejects(cash.settle(u,w.id,k,settlement(s,101)),{code:'SPENT_EXCEEDS_WITHDRAWAL'})
      const foreign=await open();await assert.rejects(cash.settle(foreign.u,w.id,key(),settlement(foreign.s)),{status:404})
      const done=await cash.settle(u,w.id,k,settlement(s))
      assert.equal(done.withdrawal.spentAmount,60);assert.equal(done.withdrawal.documentNumber,'FOLIO-42')
      assert.equal((await cash.settle(u,w.id,k,settlement(s))).replayed,true)
      await assert.rejects(cash.settle(u,w.id,key(),settlement(s)),{code:'WITHDRAWAL_SETTLED'})
      const workspace=await cash.workspace(u);assert.equal(workspace.availableCash,940);assert.equal(workspace.entries.filter(e=>e.kind==='return').length,1)
    })
    await t.test('an outstanding withdrawal can return in the next session without changing the previous close',async()=>{
      const {u,s}=await open(),w=(await issue(u,s,300)).withdrawal
      const saved=await close(u,s,700)
      const old=await store.getRegisterClosureRevision(u,s.id,1)
      assert.equal(saved.cashOut,300);assert.equal(saved.expectedCash,700)
      const next=await store.openRegisterSession(u,{...(await store.getRegisterOpening(u)),additionalCash:0})
      assert.equal(next.openingCash,700)
      await cash.settle(u,w.id,key(),settlement(next,250))
      assert.equal((await cash.workspace(u)).availableCash,750)
      assert.deepEqual(await store.getRegisterClosureRevision(u,s.id,1),old)
      const current=await store.getRegisterClosure(u,next.id);assert.equal(current.live.cashLedger.cashIn,50)
      const nextClose=await close(u,next,750)
      const pdf=await createCashClosurePdf(nextClose)
      assert.ok(pdf.length<30000);assert.ok((await PDFDocument.load(pdf)).getPageCount()<=3)
    })
    await t.test('returned denominations must match the excess and are persisted without duplicate cash entries',async()=>{
      const {u,s}=await open(),w=(await issue(u,s,300)).withdrawal,operation=key()
      await assert.rejects(cash.settle(u,w.id,operation,{...settlement(s,200),returnDenominations:{100:2}}),{code:'RETURN_COUNT_MISMATCH'})
      assert.equal((await cash.workspace(u)).withdrawals.find(row=>row.id===w.id).status,'pending')
      const body={...settlement(s,200),returnDenominations:{100:1}}
      const result=await cash.settle(u,w.id,operation,body)
      assert.equal(result.withdrawal.returnDenominations[100],1)
      assert.equal((await cash.settle(u,w.id,operation,body)).replayed,true)
      const workspace=await cash.workspace(u)
      assert.equal(workspace.availableCash,800)
      assert.equal(workspace.entries.filter(e=>e.kind==='return').length,1)
      assert.equal(workspace.entries.find(e=>e.kind==='return').returnDenominations[100],1)
    })
    await t.test('staff stock edits retain the operator and batch retries keep the original movement',async()=>{
      const {u}=await open(),other=await user(),item=await product(2.25,'kg')
      await store.adjustItem(item.id,{type:'stock_in',quantity:.75,note:'Recepción'},u)
      const operation=key(),body={type:'adjustment',note:'Conteo',items:[{itemId:item.id,quantity:2.5,expectedQuantity:3}]}
      await store.saveInventoryBatch(body,operation,u)
      assert.equal((await store.saveInventoryBatch(body,operation,other)).replayed,true)
      const movements=(await store.listMovements()).filter(m=>m.itemId===item.id&&m.type==='adjustment')
      assert.equal(movements.length,1);assert.ok(movements[0].note.includes('@'+u.username))
      assert.equal((await store.listItems()).find(i=>i.id===item.id).quantity,2.5)
    })
    await t.test('withdrawal and close share a mutex and the closure rejects stale cash movements',async()=>{
      const {u,s}=await open(),workspace=await store.getRegisterClosure(u,s.id)
      const race=await Promise.allSettled([issue(u,s,100),store.saveRegisterClosure(u,s.id,{openingCash:1000,cashIn:0,cashOut:0,countedCash:1000,countedCard:0,operator:u.name,note:'test',expectedRevision:0,fingerprint:workspace.live.fingerprint})])
      assert.equal(race.filter(r=>r.status==='fulfilled').length,1)
      assert.ok(['CLOSURE_CHANGED','SESSION_REQUIRED'].includes(race.find(r=>r.status==='rejected').reason.code))
    })
    await t.test('cash refunds cannot spend money already withdrawn',async()=>{
      const {u,s,actor}=await open(0),item=await product(2)
      const sale=await store.createSale([{itemId:item.id,quantity:1}],'cash',key(),1000,actor)
      await issue(u,s,900)
      const {refund}=await store.prepareRefund(sale.id,{amount:1000,items:[{lineId:sale.items[0].lineId,quantity:1}],reason:'Ficticio',restock:false,creditNoteRequired:false,originalDocumentType:'',originalFolio:''})
      await assert.rejects(store.completeRefund(refund.id),{code:'INSUFFICIENT_CASH'})
      assert.equal((await cash.workspace(u)).availableCash,100)
    })
    await t.test('POS records unstocked quantities without negative stock; Point failures restore only allocated units',async()=>{
      const {actor}=await open(0),item=await product(),operation=key()
      const sale=await store.createSale([{itemId:item.id,quantity:2}],'cash',operation,2000,actor)
      assert.equal(sale.items[0].inventoryQuantity,0);assert.equal(sale.items[0].unstockedQuantity,2)
      assert.equal((await store.createSale([{itemId:item.id,quantity:2}],'cash',operation,2000,actor)).id,sale.id)
      const decimal=await product(.75,'kg')
      const point=await store.createSale([{itemId:decimal.id,quantity:1.25}],'card',key(),null,actor)
      assert.equal(point.items[0].inventoryQuantity,.75);assert.equal(point.items[0].unstockedQuantity,.5)
      await store.markCardSaleFailed(point.id);await store.markCardSaleFailed(point.id)
      const items=await store.listItems();assert.equal(items.find(i=>i.id===item.id).quantity,0);assert.equal(items.find(i=>i.id===decimal.id).quantity,.75)
      assert.equal(inventoryRepresentation(items.map(i=>({...i,updated_at:i.updatedAt,expiry_date:i.expiryDate}))).body.includes(item.id),false)
    })
    await t.test('a concurrent cash refund and withdrawal cannot consume the same sale proceeds',async()=>{
      const {u,s,actor}=await open(0),item=await product(1)
      const sale=await store.createSale([{itemId:item.id,quantity:1}],'cash',key(),1000,actor)
      const {refund}=await store.prepareRefund(sale.id,{amount:1000,items:[{lineId:sale.items[0].lineId,quantity:1}],reason:'Ficticio',restock:true,creditNoteRequired:false,originalDocumentType:'',originalFolio:''})
      const race=await Promise.allSettled([store.completeRefund(refund.id),issue(u,s,900)])
      assert.equal(race.filter(r=>r.status==='fulfilled').length,1)
      assert.equal(race.find(r=>r.status==='rejected').reason.code,'INSUFFICIENT_CASH')
      assert.ok([0,100].includes((await cash.workspace(u)).availableCash))
    })
    await t.test('unused advances return in full and fully spent advances settle without adding cash',async()=>{
      const {u,s}=await open(),unused=(await issue(u,s,100)).withdrawal
      await cash.settle(u,unused.id,key(),{sessionId:s.id,spentAmount:0,detail:'Compra cancelada'})
      assert.equal((await cash.workspace(u)).availableCash,1000)
      const spent=(await issue(u,s,100)).withdrawal
      await cash.settle(u,spent.id,key(),settlement(s,100))
      const workspace=await cash.workspace(u)
      assert.equal(workspace.availableCash,900)
      assert.equal(workspace.entries.filter(e=>e.kind==='return').length,2)
      assert.equal(workspace.withdrawals.filter(w=>w.status==='settled').length,2)
    })
    if(postgres)await t.test('a failed return rolls back the settlement and its idempotency entry',async()=>{
      const {u,s}=await open(),w=(await issue(u,s)).withdrawal,operation=key()
      await db.query(`CREATE FUNCTION fail_cash_return() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.kind='return' THEN RAISE EXCEPTION 'simulated cash return failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER test_cash_return BEFORE INSERT ON register_cash_entries FOR EACH ROW EXECUTE FUNCTION fail_cash_return()`)
      try{await assert.rejects(cash.settle(u,w.id,operation,settlement(s)),/simulated cash return failure/)}
      finally{await db.query('DROP TRIGGER test_cash_return ON register_cash_entries')}
      assert.equal((await db.query('SELECT status FROM register_cash_withdrawals WHERE id=$1',[w.id])).rows[0].status,'pending')
      assert.equal((await db.query('SELECT count(*)::int AS n FROM register_cash_operations WHERE id=$1',[operation])).rows[0].n,0)
      await cash.settle(u,w.id,operation,settlement(s));assert.equal((await cash.workspace(u)).availableCash,940)
      const before=await readInventorySnapshot(db);assert.equal((await readInventorySnapshot(db,before.revision)).rows,null)
    })
    if(postgres)await t.test('last tracked unit remains exclusive across authenticated POS, Point and web; shortfalls stay explicit',async()=>{
      const {actor}=await open(0),item=await product(1)
      const integration=store.getInventoryIntegrationStore();await integration.initialize()
      const issued=await integration.createClient({name:'Local web',environment:'test',expiresInDays:1,reservationsEnabled:true})
      const owner={id:issued.client.id,environment:'test'}
      const holds=store.getStockReservationStore()
      const result=await Promise.allSettled([
        store.createSale([{itemId:item.id,quantity:1}],'cash',key(),1000,actor),
        store.createSale([{itemId:item.id,quantity:1}],'card',key(),null,actor),
        holds.create(owner,key(),{externalReference:key(),currency:'CLP',expectedTotal:1000,items:[{itemId:item.id,quantity:'1.00',unit:item.unit,unitPrice:1000}]}),
      ])
      assert.equal(result[0].status,'fulfilled');assert.equal(result[1].status,'fulfilled')
      const allocated=result[0].value.items[0].inventoryQuantity+result[1].value.items[0].inventoryQuantity+(result[2].status==='fulfilled'?1:0)
      assert.equal(allocated,1);assert.equal((await store.listItems()).find(i=>i.id===item.id).quantity,0)
      if(result[2].status==='fulfilled')await holds.release(owner,result[2].value.reservation.id,key(),{reason:'checkout_cancelled'})
      else assert.equal(result[2].reason.code,'INSUFFICIENT_STOCK')
      await store.markCardSaleFailed(result[1].value.id)
    })
    if(postgres)await t.test('a restarted worker recovers a lost withdrawal response without issuing it again',async()=>{
      const {u,s}=await open(),operation=key(),body={sessionId:s.id,amount:100,recipient:'Producción',purpose:'Compra local'}
      const first=await cash.issue(u,operation,body)
      const program=`import {initializeStore,closeStore,getRegisterCashStore} from './server/store.js';
        await initializeStore();const result=await getRegisterCashStore().issue(${JSON.stringify(u)},${JSON.stringify(operation)},${JSON.stringify(body)});
        console.log(JSON.stringify({id:result.withdrawal.id,replayed:result.replayed}));await closeStore();`
      for(let n=0;n<2;n++){
        const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',program],{windowsHide:true,timeout:20000,
          env:{...deploymentTestEnvironment(process.env),DATABASE_URL:process.env.DATABASE_URL}})
        assert.deepEqual(JSON.parse(stdout),{id:first.withdrawal.id,replayed:true})
      }
      const current=await cash.workspace(u);assert.equal(current.availableCash,900);assert.equal(current.entries.length,1)
    })
  }finally{
    await store?.closeStore();await db?.end()
    if(admin){await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end()}
    for(const [name,value]of Object.entries(previous))value===undefined?delete process.env[name]:process.env[name]=value
    assert.ok(path.resolve(temp).toLowerCase().startsWith(path.join(os.tmpdir(),'bakery-cash-').toLowerCase()))
    await fs.rm(temp,{recursive:true,force:true})
  }
})
