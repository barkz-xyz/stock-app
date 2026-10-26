import { shareSnapshot } from './snapshot.js'

const pendingReads = new Map()
const validatedReads = new Map()
let bootstrapData = null
let readGeneration = 0

function invalidateReads() {
  readGeneration += 1
  pendingReads.clear()
  validatedReads.clear()
}

function request(url, options = {}) {
  const read = !options.method || options.method === 'GET'
  const deduplicate = read && !options.signal
  if (deduplicate && pendingReads.has(url)) return pendingReads.get(url)
  if (!read) invalidateReads()
  if (!read && url.startsWith('/api/auth/')) bootstrapData = null
  const generation = readGeneration
  const conditional = read && (url.startsWith('/api/sales?') || url === '/api/bootstrap')
  const cached = conditional ? validatedReads.get(url) : null
  const execute = async () => {
    try {
      const headers = new Headers(options.headers)
      if (options.body != null && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
      if (cached) headers.set('If-None-Match', cached.etag)
      const response = await fetch(url, {
        ...options, headers,
        ...(read ? { cache: conditional ? 'no-cache' : 'no-store', signal: options.signal || AbortSignal.timeout(20000) } : {}),
      })
      if (response.status === 304 && cached) return cached.data
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        if (response.status === 401) { invalidateReads(); bootstrapData = null }
        const error = new Error(data.error || 'Something went wrong.')
        Object.assign(error, { status: response.status, ...data })
        throw error
      }
      const etag = response.headers.get('etag')
      // A browser may satisfy a successfully revalidated response from its HTTP cache.
      let result = cached && cached.etag === etag ? cached.data : data
      if (url === '/api/bootstrap' && generation === readGeneration) {
        result = shareSnapshot(bootstrapData, result)
        bootstrapData = result
      }
      if (conditional && etag && generation === readGeneration) validatedReads.set(url, { etag, data: result })
      return result
    } finally {
      // Reads started during a mutation must also be revalidated after it completes.
      if (!read) invalidateReads()
    }
  }
  if (!deduplicate) return execute()
  const pending = execute().finally(() => {
    if (pendingReads.get(url) === pending) pendingReads.delete(url)
  })
  pendingReads.set(url, pending)
  return pending
}

function localDateKey(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function metricsPeriod(range = 'today') {
  const now = new Date()
  const todayFrom = new Date(now)
  todayFrom.setHours(0, 0, 0, 0)
  const from = new Date(todayFrom)
  if (range === '7d') from.setDate(from.getDate() - 6)
  if (range === '30d') from.setDate(from.getDate() - 29)
  const duration = now.getTime() - from.getTime()
  const previousTo = new Date(from)
  const previousFrom = new Date(previousTo.getTime() - duration)
  return {
    from: from.toISOString(),
    to: new Date(now.getTime() + 1000).toISOString(),
    previousFrom: previousFrom.toISOString(),
    previousTo: previousTo.toISOString(),
    todayFrom: todayFrom.toISOString(),
    todayTo: new Date(now.getTime() + 1000).toISOString(),
    businessDate: localDateKey(now),
  }
}

export const api = {
  bootstrap: () => request('/api/bootstrap'),
  authStatus: () => request('/api/auth/status'),
  login: (username,password) => request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username,password }) }),
  setupAdmin: body => request('/api/auth/setup',{method:'POST',body:JSON.stringify(body)}),
  changePassword: body => request('/api/auth/password',{method:'POST',body:JSON.stringify(body)}),
  users: () => request('/api/users'),
  integrationClients: () => request('/api/integration-clients'),
  createIntegrationClient: body => request('/api/integration-clients', { method: 'POST', body: JSON.stringify(body) }),
  rotateIntegrationKey: (clientId, body) => request(`/api/integration-clients/${clientId}/keys`, { method: 'POST', body: JSON.stringify(body) }),
  revokeIntegrationKey: (clientId, keyId) => request(`/api/integration-clients/${clientId}/keys/${keyId}/revoke`, { method: 'POST', body: '{}' }),
  deleteIntegrationKey: (clientId, keyId) => request(`/api/integration-clients/${clientId}/keys/${keyId}`, { method: 'DELETE' }),
  deleteIntegrationClient: clientId => request(`/api/integration-clients/${clientId}`, { method: 'DELETE' }),
  setIntegrationReservations: (clientId, enabled) => request(`/api/integration-clients/${clientId}`, { method: 'PATCH', body: JSON.stringify({ reservationsEnabled: enabled }) }),
  stockReservations: () => request('/api/stock-reservations'),
  releaseStockReservation: (id, body, key) => request(`/api/stock-reservations/${id}/release`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(body) }),
  createUser: body => request('/api/users',{method:'POST',body:JSON.stringify(body)}),
  updateUser: (id,body) => request(`/api/users/${id}`,{method:'PATCH',body:JSON.stringify(body)}),
  openRegister: body => request('/api/register-sessions',{method:'POST',body:JSON.stringify(typeof body==='number'?{openingCash:body}:body)}),
  registerCash: () => request('/api/register-cash'),
  withdrawCash: (body,key) => request('/api/register-cash/withdrawals',{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)}),
  settleCash: (id,body,key) => request(`/api/register-cash/withdrawals/${id}/settle`,{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)}),
  registerClosure: (id,options) => request(`/api/register-sessions/${id}/closure`,options),
  saveRegisterClosure: (id,body) => request(`/api/register-sessions/${id}/closure`,{method:'POST',body:JSON.stringify(body)}),
  registerPdfUrl: (id,revision) => `/api/register-sessions/${id}/closure/pdf?${new URLSearchParams({revision})}`,
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  items: () => request('/api/items'),
  movements: () => request('/api/movements?limit=100'),
  sales: () => request('/api/sales?limit=50'),
  metrics: (range = 'today', options) => request(`/api/metrics?${new URLSearchParams(metricsPeriod(range))}`, options),
  cashClosure: (date, options) => request(`/api/cash-closures${date ? `?date=${encodeURIComponent(date)}` : ''}`, options),
  saveCashClosure: (closure) => request('/api/cash-closures', { method: 'POST', body: JSON.stringify(closure) }),
  cashClosurePdfUrl: (date, revision) => `/api/cash-closures/${encodeURIComponent(date)}/pdf?${new URLSearchParams({ revision })}`,
  dailyReportUrl: (language = 'es') => `/api/reports/daily?${new URLSearchParams({ ...metricsPeriod('today'), language })}`,
  posConfig: () => request('/api/pos/config'),
  terminal: () => request('/api/pos/terminal'),
  posManagement: () => request('/api/pos/management'),
  createPointStore: (store) => request('/api/pos/stores', { method: 'POST', body: JSON.stringify(store) }),
  updatePointStore: (id, store) => request(`/api/pos/stores/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(store) }),
  deletePointStore: (id) => request(`/api/pos/stores/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  createPointRegister: (register) => request('/api/pos/registers', { method: 'POST', body: JSON.stringify(register) }),
  updatePointRegister: (id, register) => request(`/api/pos/registers/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(register) }),
  deletePointRegister: (id) => request(`/api/pos/registers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  setPointTerminalMode: (id, operating_mode) => request(`/api/pos/terminals/${encodeURIComponent(id)}/mode`, { method: 'PATCH', body: JSON.stringify({ operating_mode }) }),
  createItem: (item) => request('/api/items', { method: 'POST', body: JSON.stringify(item) }),
  updateItem: (id, item) => request(`/api/items/${id}`, { method: 'PATCH', body: JSON.stringify(item) }),
  deleteItem: (id) => request(`/api/items/${id}`, { method: 'DELETE' }),
  adjustItem: (id, adjustment) => request(`/api/items/${id}/adjust`, { method: 'POST', body: JSON.stringify(adjustment) }),
  inventoryBatch: (batch, key) => request('/api/inventory/batch', { method: 'POST', body: JSON.stringify(batch), headers: { 'Idempotency-Key': key }, signal: AbortSignal.timeout(20000) }),
  salesHistory: (filters, options) => request(`/api/sales/history?${new URLSearchParams(filters)}`, options),
  checkout: (key) => request(`/api/checkouts/${encodeURIComponent(key)}`),
  cashSale: (items, key, cashReceived) => request('/api/sales/cash', { method: 'POST', body: JSON.stringify({ items, ...(cashReceived != null ? { cashReceived } : {}) }), ...(key ? { headers: { 'Idempotency-Key': key } } : {}), signal: AbortSignal.timeout(20000) }),
  cardSale: (items, key) => request('/api/sales/card', { method: 'POST', body: JSON.stringify({ items }), ...(key ? { headers: { 'Idempotency-Key': key } } : {}), signal: AbortSignal.timeout(20000) }),
  sale: (id, refresh = false) => request(`/api/sales/${id}${refresh ? '?refresh=true' : ''}`),
  retryCardSale: (id) => request(`/api/sales/${id}/retry-card`, { method: 'POST' }),
  cancelSale: (id) => request(`/api/sales/${id}/cancel`, { method: 'POST' }),
  refundSale: (id, refund) => request(`/api/sales/${id}/refunds`, { method: 'POST', body: JSON.stringify(refund) }),
  retryRefund: (saleId, refundId) => request(`/api/sales/${saleId}/refunds/${refundId}/retry`, { method: 'POST' }),
  printRefundCopy: (saleId, refundId) => request(`/api/sales/${saleId}/refunds/${refundId}/print-copy`, { method: 'POST' }),
  reconcilePointSale: (saleId) => request(`/api/sales/${saleId}/reconcile-point`, { method: 'POST' }),
  resolveRefundInventory: (saleId, refundId, restock) => request(`/api/sales/${saleId}/refunds/${refundId}/inventory-review`, { method: 'PATCH', body: JSON.stringify({ restock }) }),
  recordCreditNote: (saleId, refundId, creditNote) => request(`/api/sales/${saleId}/refunds/${refundId}/credit-note`, { method: 'PATCH', body: JSON.stringify(creditNote) }),
}
