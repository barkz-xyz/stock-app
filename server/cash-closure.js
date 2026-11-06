import crypto from 'node:crypto'
import { cashCountTotal, cleanCashCount } from '../src/cashCount.js'
import { businessDayKey } from '../src/registerDay.js'
export { cashDenominations } from '../src/cashCount.js'

export const closureTimeZone = process.env.BAKERY_TIME_ZONE || 'America/Santiago'
export const closureError = (message, status = 400, code = 'INVALID_CLOSURE') => Object.assign(new Error(message), { status, code })
export const businessDateAt = value => businessDayKey(value, closureTimeZone)
function validateClosureDate(value = businessDateAt()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value || value < '2000-01-01' || value > businessDateAt()) {
    throw closureError('Selecciona una fecha válida, hasta el día de hoy en Chile.')
  }
  return value
}
// Find calendar boundaries in the bakery time zone, including Chile's midnight DST changes.
function businessDayBoundary(key) {
  const midnight = Date.parse(`${key}T00:00:00Z`)
  let low = midnight - 36 * 3600000, high = midnight + 60 * 3600000
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (businessDateAt(mid) < key) low = mid + 1
    else high = mid
  }
  return new Date(low)
}
export function closurePeriod(date) {
  const businessDate = validateClosureDate(date)
  const next = new Date(Date.parse(`${businessDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)
  return { businessDate, timeZone: closureTimeZone, from: businessDayBoundary(businessDate), to: businessDayBoundary(next) }
}
export function closureHistoryQuery(query = {}) {
  const month = query.month ?? businessDateAt().slice(0, 7)
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < '2000-01' || month > businessDateAt().slice(0, 7)) {
    throw closureError('Selecciona un mes válido, hasta el mes actual en Chile.')
  }
  const integer = (value, fallback, min, max) => {
    if (value == null) return fallback
    if (!['number', 'string'].includes(typeof value) || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw closureError('Selecciona una página de cierres válida.')
    return Number(value)
  }
  const [year, number] = month.split('-').map(Number)
  const firstDate = `${month}-01`, nextDate = new Date(Date.UTC(year, number, 1)).toISOString().slice(0, 10)
  return { month, timeZone: closureTimeZone, firstDate, nextDate, from: businessDayBoundary(firstDate), to: businessDayBoundary(nextDate),
    limit: integer(query.limit, 40, 1, 100), offset: integer(query.offset, 0, 0, 1000000) }
}
const instant = value => value ? new Date(value).toISOString() : null
const refundDate = r => r.processedAt || r.updatedAt || r.createdAt
export function buildClosureSummary(sales, period, { registerSessionId = null } = {}) {
  const within = value => value && new Date(value) >= period.from && new Date(value) < period.to
  const cash = { gross: 0, refunds: 0, net: 0, transactions: 0, refundCount: 0 }
  const card = { ...cash, recordedFees: 0, recordedSettlement: 0, reconciledTransactions: 0, unreconciledTransactions: 0 }
  const operations = [], excluded = []
  for (const sale of sales) {
    const method = sale.paymentMethod
    if (!['cash', 'card'].includes(method)) continue
    const totals = method === 'cash' ? cash : card
    const paidAt = sale.paidAt || sale.createdAt
    const originalSession = !registerSessionId || sale.registerSessionId === registerSessionId
    if (originalSession && within(paidAt)) {
      if (['paid', 'refunded'].includes(sale.status)) {
        totals.gross += sale.total
        totals.transactions++
        if (method === 'card') {
          if (sale.mpNetReceivedAmount != null) {
            card.recordedFees += sale.mpFeeAmount
            card.recordedSettlement += sale.mpNetReceivedAmount
            card.reconciledTransactions++
          } else card.unreconciledTransactions++
        }
        operations.push({ id: sale.id, saleId: sale.id, shortId: sale.shortId, type: 'sale', method,
          at: instant(paidAt), amount: sale.total, reference: sale.mpOperationId || sale.mpPaymentId || '',
          terminal: sale.mpTerminalSerial || '', cardBrand: sale.mpCardBrand || '', cardLastFour: sale.mpCardLastFour || '',
          fee: method === 'card' && sale.mpNetReceivedAmount != null ? sale.mpFeeAmount : null,
          settlement: method === 'card' ? sale.mpNetReceivedAmount : null,
          items: sale.items.map(i => ({ name: i.name, quantity: i.quantity, unitPrice: i.unitPrice, lineTotal: i.lineTotal })) })
      } else excluded.push({ id: sale.id, shortId: sale.shortId, type: 'sale', method, at: instant(paidAt), status: sale.status, amount: sale.total })
    }
    for (const refund of sale.refunds) {
      const refundSession = method === 'cash' && refund.cashRegisterSessionId ? refund.cashRegisterSessionId : sale.registerSessionId
      if (registerSessionId && refundSession !== registerSessionId) continue
      if (refund.status === 'processed' && within(refundDate(refund))) {
        totals.refunds += refund.amount
        totals.refundCount++
        operations.push({ id: refund.id, saleId: sale.id, shortId: sale.shortId, type: 'refund', method,
          at: instant(refundDate(refund)), amount: -refund.amount, reference: refund.mpRefundId || refund.mpReferenceId || '',
          reason: refund.reason, originalSaleAt: instant(paidAt),
          cashRegisterSessionId: refund.cashRegisterSessionId || null, processedBy: refund.processedBy || null,
          items: refund.items.map(i => ({ name: i.name, quantity: i.quantity, unitPrice: i.unitPrice, lineTotal: -i.lineTotal })) })
      } else if (refund.status !== 'processed' && within(refund.createdAt)) {
        excluded.push({ id: refund.id, shortId: sale.shortId, type: 'refund', method, at: instant(refund.createdAt), status: refund.status, amount: refund.amount })
      }
    }
  }
  cash.net = cash.gross - cash.refunds
  card.net = card.gross - card.refunds
  operations.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  excluded.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  const summary = { businessDate: period.businessDate, timeZone: period.timeZone, from: period.from.toISOString(), to: period.to.toISOString(),
    cash, card, gross: cash.gross + card.gross, refunds: cash.refunds + card.refunds,
    net: cash.net + card.net, transactions: cash.transactions + card.transactions,
    pendingCount: excluded.filter(o => ['pending', 'processing'].includes(o.status)).length, operations, excluded }
  return { ...summary, fingerprint: crypto.createHash('sha256').update(JSON.stringify(summary)).digest('hex') }
}

export function cleanClosureInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw closureError('Envía un formulario de cierre válido.')
  const money = (key, signed = false) => {
    const value = body[key]
    const label = { openingCash: 'el fondo inicial', cashIn: 'las entradas', cashOut: 'los retiros', countedCash: 'el efectivo contado' }[key]
    if (!['string','number'].includes(typeof value) || String(value).trim() === '') throw closureError(`Completa ${label} en pesos enteros.`)
    const amount = Number(value)
    if (!Number.isSafeInteger(amount) || Math.abs(amount) > 100000000000 || (!signed && amount < 0)) throw closureError(`Revisa ${label}. Usa montos en pesos enteros dentro del límite permitido.`)
    return amount
  }
  const input = { businessDate: validateClosureDate(body.businessDate), openingCash: money('openingCash'),
    cashIn: money('cashIn'), cashOut: money('cashOut'), countedCash: money('countedCash'),
    operator: String(body.operator || '').trim(), terminalReference: String(body.terminalReference || '').trim(),
    note: String(body.note || '').trim(), expectedRevision: Number(body.expectedRevision), fingerprint: body.fingerprint,
    denominations: null }
  if (!input.operator || input.operator.length > 80 || input.terminalReference.length > 100 || input.note.length > 1000) throw closureError('Indica un responsable (hasta 80 caracteres) y una observación de hasta 1.000 caracteres.')
  if (!['string','number'].includes(typeof body.expectedRevision) || String(body.expectedRevision).trim() === '' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !/^[a-f0-9]{64}$/.test(input.fingerprint || '')) throw closureError('Actualiza los datos del día antes de cerrar.', 409, 'CLOSURE_CHANGED')
  if (body.denominations != null) {
    try { input.denominations = cleanCashCount(body.denominations) } catch (error) { throw closureError(error.message) }
    if (cashCountTotal(input.denominations) !== input.countedCash) throw closureError('El desglose de efectivo no coincide con el total contado.')
  }
  return input
}

export function createClosure(summary, input, existing) {
  if (summary.fingerprint !== input.fingerprint || (existing?.revision || 0) !== input.expectedRevision) throw closureError('Las operaciones o el cierre cambiaron. Actualiza el día y revisa los montos antes de confirmar.', 409, 'CLOSURE_CHANGED')
  const cashIn = summary.cashLedger?.cashIn ?? input.cashIn, cashOut = summary.cashLedger?.cashOut ?? input.cashOut
  const expectedCash = input.openingCash + summary.cash.net + cashIn - cashOut
  const difference = input.countedCash - expectedCash
  if (difference !== 0 && !input.note) {
    throw closureError('Agrega una observación para explicar el faltante o sobrante de efectivo.')
  }
  return { id: existing?.id || crypto.randomUUID(), businessDate: input.businessDate, revision: (existing?.revision || 0) + 1,
    openingCash: input.openingCash, cashAdjustments: cashIn - cashOut, cashIn, cashOut,
    countedCash: input.countedCash, countedCard: summary.card.net, cardTotalSource: 'pos', operator: input.operator, terminalReference: input.terminalReference,
    denominations: input.denominations, cashSales: summary.cash.net, cardSales: summary.card.net, totalSales: summary.net,
    expectedCash, difference, cardDifference: null, transactionCount: summary.transactions, note: input.note,
    closedAt: new Date().toISOString(), snapshot: summary }
}
