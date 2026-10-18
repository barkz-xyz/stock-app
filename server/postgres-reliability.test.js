import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { setTimeout as delay } from 'node:timers/promises'
import { closeChangeListener, listenForDatabaseChanges, subscribeToChanges } from './changes.js'

// Opt-in integration test: all writes stay in a fresh schema, never business tables.
test('PostgreSQL serializes checkout retries and aggregates the full business day', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const schema = `verify_checkout_${crypto.randomUUID().replaceAll('-', '')}`
  const connectionString = process.env.TEST_DATABASE_URL
  const ssl = !connectionString.includes('railway.internal') && process.env.PGSSLMODE !== 'disable' ? { rejectUnauthorized: false } : false
  const admin = new pg.Client({ connectionString, ssl })
  let store
  const previousUrl = process.env.DATABASE_URL
  try {
    await admin.connect()
    await admin.query(`CREATE SCHEMA "${schema}"`)
    const isolated = new URL(connectionString)
    isolated.searchParams.set('options', `-c search_path=${schema}`)
    process.env.DATABASE_URL = isolated.href
    store = await import(`./store.js?postgres=${crypto.randomUUID()}`)
    await store.initializeStore()
    const item = await store.createItem({ name: 'Isolated retry test', category: 'Bread', unit: 'pieces', quantity: 20, price: 1000, sellable: true, lowStockThreshold: 0, sku: 'ISOLATED', expiryDate: null })
    const key = crypto.randomUUID()
    const cart = [{ itemId: item.id, quantity: 2 }]
    const sales = await Promise.all(Array.from({ length: 8 }, () => store.createSale(cart, 'cash', key)))
    assert.equal(new Set(sales.map(sale => sale.id)).size, 1)
    assert.equal((await store.listItems())[0].quantity, 18)
    assert.equal((await store.listSales()).length, 1)
    await assert.rejects(store.createSale(cart, 'card', key), { code: 'CHECKOUT_CONFLICT' })
    assert.equal((await store.getSaleByCheckoutKey(key)).id, sales[0].id)
    const cardKey = crypto.randomUUID()
    const cards = await Promise.all(Array.from({ length: 4 }, () => store.createSale(cart, 'card', cardKey)))
    assert.equal(new Set(cards.map(sale => sale.id)).size, 1)
    assert.equal((await store.listItems())[0].quantity, 16)
    const claims = await Promise.all(Array.from({ length: 4 }, () => store.claimPointOrder(cards[0].id)))
    assert.equal(claims.filter(Boolean).length, 1)
    await admin.query(`SET search_path TO "${schema}"`)
    await admin.query('UPDATE sales SET point_order_lease_until=NOW()-INTERVAL \'1 second\' WHERE id=$1', [cards[0].id])
    assert.equal(await store.claimPointOrder(cards[0].id), true)
    await admin.query(`INSERT INTO sales (id,status,payment_method,total,paid_at,created_at)
      SELECT gen_random_uuid(),'paid','cash',1000,'2026-10-17T20:00:00Z','2026-10-17T20:00:00Z' FROM generate_series(1,65)`)
    await admin.query(`UPDATE sales SET paid_at='2020-01-01',created_at='2020-01-01' WHERE checkout_key IS NOT NULL`)
    await admin.query(`INSERT INTO refunds (id,sale_id,status,amount,reason,processed_at) VALUES ($1,$2,'processed',500,'isolated test','2026-10-18T02:59:00Z')`, [crypto.randomUUID(), sales[0].id])
    const now = new Date('2026-10-18T02:59:59Z')
    assert.deepEqual(await store.getDailySummary(now), { businessDate: '2026-10-17', transactions: 65, grossRevenue: 65000, refundedTotal: 500, revenue: 64500 })
    const boot = await store.getBootstrapData(now)
    assert.equal(boot.sales.length, 50)
    assert.equal(boot.dailySummary.transactions, 65)
    assert.equal((await store.getDailySummary(new Date('2026-10-18T03:00:00Z'))).transactions, 0)
    // Closing runs in the same isolated schema; negative card days are valid (older-sale refunds).
    await admin.query(`INSERT INTO refunds (id,sale_id,status,amount,reason,processed_at,created_at)
      VALUES ($1,$2,'processed',3000,'older card refund','2026-10-17T20:00:00Z','2026-10-17T20:00:00Z')`, [crypto.randomUUID(), cards[0].id])
    let closing = await store.getCashClosureWorkspace('2026-10-17')
    assert.equal(closing.live.cash.net, 64500)
    assert.equal(closing.live.card.net, -3000)
    const declaration = { businessDate: '2026-10-17', openingCash: 1000, cashIn: 0, cashOut: 0,
      countedCash: 65500, countedCard: -3000, operator: 'Isolated tester', note: 'Refund from an earlier day.',
      expectedRevision: 0, fingerprint: closing.live.fingerprint }
    const closeAttempts = await Promise.allSettled(Array.from({ length: 4 }, () => store.saveCashClosure(declaration)))
    assert.equal(closeAttempts.filter(r => r.status === 'fulfilled').length, 1)
    for (const rejected of closeAttempts.filter(r => r.status === 'rejected')) assert.equal(rejected.reason.code, 'CLOSURE_CHANGED')
    const firstClose = await store.getCashClosureRevision('2026-10-17', 1)
    assert.equal(firstClose.cardSales, -3000)
    assert.equal(firstClose.difference, 0)
    assert.equal(firstClose.cardDifference, 0)
    await admin.query(`INSERT INTO sales (id,status,payment_method,total,paid_at,created_at)
      VALUES ($1,'paid','cash',2500,'2026-10-17T22:00:00Z','2026-10-17T22:00:00Z')`, [crypto.randomUUID()])
    closing = await store.getCashClosureWorkspace('2026-10-17')
    assert.equal(closing.stale, true)
    await assert.rejects(store.saveCashClosure({ ...declaration, expectedRevision: 1 }), { code: 'CLOSURE_CHANGED' })
    const correction = await store.saveCashClosure({ ...declaration, countedCash: 68000, expectedRevision: 1,
      fingerprint: closing.live.fingerprint, note: 'Include later collection.' })
    assert.equal(correction.revision, 2)
    assert.deepEqual(await store.getCashClosureRevision('2026-10-17', 1), firstClose)
    assert.equal((await store.getCashClosureWorkspace('2026-10-17')).stale, false)
    const batchItem = await store.createItem({ name: 'Batch integration', category: 'Bread', unit: 'pieces', quantity: 0, price: 1000, sellable: true, lowStockThreshold: 0, sku: 'BATCH-QA', expiryDate: null })
    const batchKey = crypto.randomUUID(), batchBody = { type: 'stock_in', items: [{ itemId: batchItem.id, quantity: 10 }] }
    const batches = await Promise.all(Array.from({ length: 5 }, () => store.saveInventoryBatch(batchBody, batchKey)))
    assert.equal(batches.filter(r => !r.replayed).length, 1)
    assert.equal((await store.listItems()).find(i => i.id === batchItem.id).quantity, 10)
    await assert.rejects(store.saveInventoryBatch({ type: 'adjustment', items: [{ itemId: batchItem.id, quantity: 0, expectedQuantity: 9 }] }, crypto.randomUUID()), { code: 'STOCK_CHANGED' })
    const tenderSale = await store.createSale([{ itemId: batchItem.id, quantity: 1 }], 'cash', crypto.randomUUID(), 5000)
    assert.equal(tenderSale.cashReceived, 5000); assert.equal(tenderSale.cashChange, 4000)
    assert.equal((await store.getSale(tenderSale.id)).cashReceived, 5000)
    const historyResult = await store.searchSales({ search: tenderSale.shortId, method: 'cash', status: 'paid' })
    assert.equal(historyResult.total, 1); assert.equal(historyResult.sales[0].id, tenderSale.id)
    assert.equal((await store.searchSales({ search: tenderSale.mpExternalReference })).total, 1)
    assert.equal((await store.searchSales({ search: '%' })).total, 0)
    const adminUser=await store.createUser({username:'admin.qa',name:'Admin QA',role:'admin',password:'Admin-QA-12345'},true)
    const cashierUser=await store.createUser({username:'cashier.qa',name:'Cashier QA',role:'cashier',password:'Cashier-QA-12345'})
    const sessionA=await store.openRegisterSession(adminUser,1000),sessionB=await store.openRegisterSession(cashierUser,0)
    const actorA={...adminUser,sessionId:sessionA.id},actorB={...cashierUser,sessionId:sessionB.id}
    const aSale=await store.createSale([{itemId:batchItem.id,quantity:1}],'cash',crypto.randomUUID(),5000,actorA)
    await store.createSale([{itemId:batchItem.id,quantity:1}],'cash',crypto.randomUUID(),2000,actorB)
    assert.equal(aSale.cashierId,adminUser.id);assert.equal(aSale.registerSessionId,sessionA.id)
    assert.equal((await store.searchSales({},cashierUser)).total,1)
    await assert.rejects(store.getRegisterClosure(cashierUser,sessionA.id),{status:404})
    const aWorkspace=await store.getRegisterClosure(adminUser,sessionA.id)
    assert.equal(aWorkspace.live.cash.net,1000)
    const aDeclaration={openingCash:999999,cashIn:0,cashOut:0,countedCash:2000,countedCard:0,operator:'Spoof',expectedRevision:0,fingerprint:aWorkspace.live.fingerprint}
    const race=await Promise.allSettled([store.saveRegisterClosure(adminUser,sessionA.id,aDeclaration),store.createSale([{itemId:batchItem.id,quantity:1}],'cash',crypto.randomUUID(),2000,actorA)])
    assert.equal(race.filter(r=>r.status==='fulfilled').length,1,'Closing and a new sale cannot both succeed with the same snapshot')
    let sessionClose=race[0].value
    if(!sessionClose){assert.equal(race[0].reason.code,'CLOSURE_CHANGED');const next=await store.getRegisterClosure(adminUser,sessionA.id);sessionClose=await store.saveRegisterClosure(adminUser,sessionA.id,{...aDeclaration,countedCash:1000+next.live.cash.net,fingerprint:next.live.fingerprint})}
    assert.equal(sessionClose.openingCash,1000);assert.equal(sessionClose.operator,'Admin QA')
    await assert.rejects(store.createSale([{itemId:batchItem.id,quantity:1}],'cash',crypto.randomUUID(),2000,actorA),{code:'SESSION_REQUIRED'})
    const pendingCard=await store.createSale([{itemId:batchItem.id,quantity:1}],'card',crypto.randomUUID(),null,actorB)
    const bWorkspace=await store.getRegisterClosure(cashierUser,sessionB.id)
    await assert.rejects(store.saveRegisterClosure(cashierUser,sessionB.id,{...aDeclaration,fingerprint:bWorkspace.live.fingerprint,countedCash:1000}),{code:'PENDING_PAYMENTS'})
    await store.markCardSaleFailed(pendingCard.id)
    const paidCard=await store.createSale([{itemId:batchItem.id,quantity:1}],'card',crypto.randomUUID(),null,actorB)
    const paidOrder={id:'SESSION-CARD-'+crypto.randomUUID(),status:'processed',transactions:{payments:[{id:'SESSION-PAYMENT-'+crypto.randomUUID(),status_detail:'accredited'}]}}
    await store.attachPointOrder(paidCard.id,paidOrder)
    await store.updateSaleFromPoint(paidOrder)
    const bReady=await store.getRegisterClosure(cashierUser,sessionB.id)
    assert.equal(bReady.live.card.net,1000)
    const bClosed=await store.saveRegisterClosure(cashierUser,sessionB.id,{...aDeclaration,countedCash:1000,countedCard:1000,fingerprint:bReady.live.fingerprint})
    assert.equal(bClosed.totalSales,2000);assert.equal(bClosed.cardDifference,0);assert.equal(bClosed.difference,0)
    const authHash=crypto.randomBytes(32).toString('hex');await store.createLoginSession(cashierUser.id,authHash)
    assert.equal((await store.getSessionUser(authHash)).id,cashierUser.id)
    await store.updateUser(cashierUser.id,{...cashierUser,active:false})
    assert.equal(await store.getSessionUser(authHash),null)
    await assert.rejects(store.updateUser(adminUser.id,{...adminUser,active:false}),{status:409})
    await listenForDatabaseChanges(isolated.href)
    let notifications = 0
    const unsubscribe = subscribeToChanges(() => notifications++)
    try {
      await admin.query('BEGIN')
      await admin.query('UPDATE items SET quantity=quantity+1 WHERE id=$1', [item.id])
      await delay(150)
      assert.equal(notifications, 0)
      await admin.query('ROLLBACK')
      await delay(150)
      assert.equal(notifications, 0)
      await admin.query('UPDATE items SET quantity=quantity+1 WHERE id=$1', [item.id])
      for (let attempt = 0; attempt < 20 && !notifications; attempt++) await delay(100)
      assert.ok(notifications > 0, 'Committed changes from another connection reach the listener')
    } finally { unsubscribe(); await closeChangeListener() }
  } finally {
    process.env.DATABASE_URL = previousUrl || ''
    await store?.closeStore()
    // schema is generated above with only a constant prefix and UUID hex characters.
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
  }
})
