import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

test('refund attempts retain the original key and frozen body through reloads and account switches', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis,'sessionStorage'), values = new Map()
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)}})
  t.after(()=>previous?Object.defineProperty(globalThis,'sessionStorage',previous):delete globalThis.sessionStorage)
  const first = await import(`../src/refundAttempts.js?first=${crypto.randomUUID()}`)
  const user = crypto.randomUUID(), other = crypto.randomUUID(), sale = crypto.randomUUID()
  const body = {amount:500,items:[{lineId:crypto.randomUUID(),quantity:1}],reason:'Original',restock:true}
  const attempt = first.beginRefund(user,sale,body)
  body.amount=999;body.items[0].quantity=2
  assert.equal(attempt.body.amount,500);assert.equal(attempt.body.items[0].quantity,1)
  assert.throws(()=>{attempt.body.amount=100},TypeError)
  const reload = await import(`../src/refundAttempts.js?reload=${crypto.randomUUID()}`)
  assert.deepEqual(reload.pendingRefund(user),attempt)
  assert.deepEqual(reload.beginRefund(user,crypto.randomUUID(),{amount:100,items:[]}),attempt)
  assert.equal(reload.pendingRefund(other),null)
  const otherAttempt=reload.beginRefund(other,crypto.randomUUID(),{amount:100,items:[]})
  assert.notEqual(otherAttempt.key,attempt.key)
  reload.clearRefund(user,otherAttempt.key);assert.deepEqual(reload.pendingRefund(user),attempt)
  reload.clearRefund(user,attempt.key);assert.equal(reload.pendingRefund(user),null)
  assert.deepEqual(reload.pendingRefund(other),otherAttempt)
  assert.notEqual(reload.beginRefund(user,sale,{amount:500,items:[]}).key,attempt.key)
})
