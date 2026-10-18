let storageKey = 'bakery-pending-checkout'
let memory = null
export function setCheckoutUser(id,legacyAdmin=false){const next=id?`bakery-pending-checkout:${id}`:'bakery-pending-checkout';if(next===storageKey)return;memory=null;try{if(id&&legacyAdmin&&!sessionStorage.getItem(next)&&sessionStorage.getItem('bakery-pending-checkout')){sessionStorage.setItem(next,sessionStorage.getItem('bakery-pending-checkout'));sessionStorage.removeItem('bakery-pending-checkout')}}catch{}storageKey=next}

export function pendingCheckout() {
  try {
    const value = JSON.parse(globalThis.sessionStorage?.getItem(storageKey) || 'null')
    if (value?.key && /^[0-9a-f-]{36}$/i.test(value.key) && ['cash', 'card'].includes(value.paymentMethod) && Array.isArray(value.items) && value.items.length) memory = value
  } catch { /* Keep the in-memory attempt if browser storage is unavailable. */ }
  return memory
}

export function beginCheckout(items, paymentMethod, total, cashReceived = null) {
  const existing = pendingCheckout()
  if (existing) return existing
  memory = { key: crypto.randomUUID(), items, paymentMethod, total, ...(cashReceived != null ? { cashReceived } : {}) }
  try { globalThis.sessionStorage?.setItem(storageKey, JSON.stringify(memory)) } catch { /* Memory still protects retries in this tab. */ }
  return memory
}

export function clearCheckout(key) {
  if (pendingCheckout()?.key !== key) return
  memory = null
  try { globalThis.sessionStorage?.removeItem(storageKey) } catch { /* Storage is optional. */ }
}
