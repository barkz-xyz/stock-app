const memory = new Map()
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const storageKey = userId => `bakery-pending-refund:${userId}`
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}

export function pendingRefund(userId) {
  if (!uuid(userId)) return null
  try {
    const value = JSON.parse(globalThis.sessionStorage?.getItem(storageKey(userId)) || 'null')
    if (uuid(value?.key) && uuid(value?.saleId) && value.userId === userId && value.body && Array.isArray(value.body.items)) memory.set(userId, freeze(value))
  } catch { /* Preserve the frozen in-memory attempt when storage is unavailable. */ }
  return memory.get(userId) || null
}

export function beginRefund(userId, saleId, body) {
  const existing = pendingRefund(userId)
  if (existing) return existing
  if (!uuid(userId) || !uuid(saleId)) throw new Error('Select a staff account and sale before refunding.')
  const value = freeze({ key: crypto.randomUUID(), userId, saleId, body: JSON.parse(JSON.stringify(body)) })
  memory.set(userId, value)
  try { globalThis.sessionStorage?.setItem(storageKey(userId), JSON.stringify(value)) } catch { /* Same-tab retries retain the key in memory. */ }
  return value
}

export function clearRefund(userId, key) {
  if (pendingRefund(userId)?.key !== key) return
  memory.delete(userId)
  try { globalThis.sessionStorage?.removeItem(storageKey(userId)) } catch { /* Browser storage is optional. */ }
}
