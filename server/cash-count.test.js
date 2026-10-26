import assert from 'node:assert/strict'
import test from 'node:test'
import { cashCountText, cashCountTotal, cashCountNumbers, cleanCashCount } from '../src/cashCount.js'
import { setWorkspaceUser, loadPendingBatch, savePendingBatch } from '../src/posWorkspace.js'

test('cash count inputs start empty, remove leading zeros and accept only bounded whole counts',()=>{
  for(const value of [undefined,'',0,'0','000'])assert.equal(cashCountText(value),'')
  assert.equal(cashCountText('01'),'1');assert.equal(cashCountText('00010'),'10')
  for(const value of ['-1','1.5','1e2','abc','1000001'])assert.equal(cashCountText(value),null)
  const counts=cleanCashCount(cashCountNumbers({100:'03',50:'1',10:''}))
  assert.equal(cashCountTotal(counts),350)
  for(const value of [null,[],{20:1},{100:.5},{100:-1},{100:'1'},{100:1000001}])assert.throws(()=>cleanCashCount(value))
})

test('pending inventory batches are isolated by staff account and legacy attempts migrate only to admins',()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage'),data=new Map()
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)}})
  const legacy={key:'legacy-attempt',body:{items:[{itemId:'old'}]},rows:[{id:'old'}]},cashier={key:'cashier-attempt',body:{items:[{itemId:'new'}]},rows:[{id:'new'}]}
  try{
    data.set('bakery-pending-stock-batch',JSON.stringify(legacy))
    setWorkspaceUser('cashier');assert.equal(loadPendingBatch(),null);savePendingBatch(cashier)
    setWorkspaceUser('admin',true);assert.deepEqual(loadPendingBatch(),legacy);assert.equal(data.has('bakery-pending-stock-batch'),false)
    setWorkspaceUser('other');assert.equal(loadPendingBatch(),null)
    setWorkspaceUser('cashier');assert.deepEqual(loadPendingBatch(),cashier)
    setWorkspaceUser('admin',true);savePendingBatch(null)
    setWorkspaceUser('cashier');assert.deepEqual(loadPendingBatch(),cashier)
  }finally{setWorkspaceUser(null);previous?Object.defineProperty(globalThis,'sessionStorage',previous):delete globalThis.sessionStorage}
})
