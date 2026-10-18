const storageKey = 'bakery-pending-checkout'
let memory = null

export function pendingCheckout() {
  try {
    const value = JSON.parse(globalThis.sessionStorage?.getItem(storageKey) || 'null')
    if (value?.key && /^[0-9a-f-]{36}$/i.test(value.key) && ['cash', 'card'].includes(value.paymentMethod) && Array.isArray(value.items) && value.items.length) memory = value
  } catch { /* Keep the in-memory attempt if browser storage is unavailable. */ }
  return memory
}

export function beginCheckout(items, paymentMethod, total) {
  const existing = pendingCheckout()
  if (existing) return existing
  memory = { key: crypto.randomUUID(), items, paymentMethod, total }
  try { globalThis.sessionStorage?.setItem(storageKey, JSON.stringify(memory)) } catch { /* Memory still protects retries in this tab. */ }
  return memory
}

export function clearCheckout(key) {
  if (pendingCheckout()?.key !== key) return
  memory = null
  try { globalThis.sessionStorage?.removeItem(storageKey) } catch { /* Storage is optional. */ }
}
