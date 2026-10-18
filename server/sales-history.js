import { closurePeriod } from './cash-closure.js'

export function cleanHistoryQuery(query = {}) {
  if(query.sessionId&&!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(query.sessionId))throw Object.assign(new Error('Sesión inválida.'),{status:400})
  const from = query.from ? closurePeriod(query.from).from : null
  const to = query.to ? closurePeriod(query.to).to : null
  if (from && to && new Date(from) >= new Date(to)) throw Object.assign(new Error('Revisa el rango de fechas.'), { status: 400 })
  const method = ['cash', 'card'].includes(query.method) ? query.method : ''
  const status = ['paid', 'pending', 'refunded', 'failed', 'cancelled', 'expired'].includes(query.status) ? query.status : ''
  return { from, to, method, status, search: String(query.search || '').trim().replace(/^#/, '').slice(0, 80),
    limit: Math.max(1, Math.min(Number.parseInt(query.limit) || 40, 100)), offset: Math.max(0, Math.min(Number.parseInt(query.offset) || 0, 1000000)) }
}

export function historyMatches(sale, q) {
  const at = new Date(sale.createdAt).getTime()
  return (!q.from || at >= new Date(q.from).getTime()) && (!q.to || at < new Date(q.to).getTime()) &&
    (!q.method || sale.paymentMethod === q.method) && (!q.status || (q.status === 'refunded' ? sale.refundedTotal > 0 || sale.status === 'refunded' : sale.status === q.status)) &&
    (!q.search || `${sale.id} ${sale.mpExternalReference || ''}`.replaceAll('-', '').toLowerCase().includes(q.search.replaceAll('-', '').toLowerCase()))
}
