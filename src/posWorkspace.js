const draftKey = 'bakery-cart-draft'
const favoriteKey = 'bakery-favorite-products'
export const searchText = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
export function loadCartDraft(storage = globalThis.sessionStorage) {
  try {
    const draft = JSON.parse(storage?.getItem(draftKey) || 'null')
    if (!draft || Date.now() - draft.savedAt > 86400000 || !Array.isArray(draft.items)) return []
    const seen = new Set()
    return draft.items.filter(l => typeof l.itemId === 'string' && !seen.has(l.itemId) && seen.add(l.itemId) && Number.isFinite(l.quantity) && l.quantity > 0 && l.quantity <= 10000).slice(0, 100)
  } catch { return [] }
}
export function saveCartDraft(items, storage = globalThis.sessionStorage) {
  try { if (items.length) storage?.setItem(draftKey, JSON.stringify({ savedAt: Date.now(), items })); else storage?.removeItem(draftKey) } catch { /* Storage can be unavailable. */ }
}
export function loadFavorites(storage = globalThis.localStorage) {
  try { const value = JSON.parse(storage?.getItem(favoriteKey) || '[]'); return Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string'))].slice(0, 200) : [] } catch { return [] }
}
export function saveFavorites(ids, storage = globalThis.localStorage) {
  try { storage?.setItem(favoriteKey, JSON.stringify(ids)) } catch { /* Optional preference. */ }
}
export function productLabel(name) {
  const value = String(name || '').trim()
  const match = /^(EMPANADA|ALIADO|BISCOCHO|QUEQUE|PAN|ROLLS|TARTALETA|PIZZA|PIE LIMON)\s+(.+)$/i.exec(value)
  return match ? { title: match[1], variant: match[2] } : { title: value, variant: '' }
}
export function cashTender(total, received) {
  const amount = received === '' ? NaN : Number(received)
  return { valid: Number.isSafeInteger(amount) && amount >= total && amount <= 999999999999, change: Math.max(0, amount - total) || 0 }
}

export function loadPendingBatch() {
  try {
    const saved = JSON.parse(globalThis.sessionStorage?.getItem('bakery-pending-stock-batch') || 'null')
    return saved?.key && Array.isArray(saved.body?.items) && saved.body.items.length && Array.isArray(saved.rows) ? saved : null
  } catch { return null }
}
export function savePendingBatch(value) {
  try { if (value) globalThis.sessionStorage?.setItem('bakery-pending-stock-batch', JSON.stringify(value)); else globalThis.sessionStorage?.removeItem('bakery-pending-stock-batch') } catch { /* In-memory retry still uses the same key. */ }
}
