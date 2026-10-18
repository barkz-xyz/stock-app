import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import compression from 'compression'
import express from 'express'
import { parseCalendarDate } from '../src/dates.js'
import { authStatus, login, logout, pointAccessIsProtected, requireAuth } from './auth.js'
import {
  buildPointManagement, cancelPointOrder, createPointOrder, createPointPos, createPointStore, deletePointPos, deletePointStore,
  getConfiguredTerminal, getMercadoPagoAccount, getPointOrder, getPointPayment, getPointPos, getPointStore,
  listPointPos, listPointStores, listPointTerminals, pointConfiguration, printPointRefundCopy, refundPointOrder,
  setupPointTerminal, updatePointPos, updatePointStore, validatePointWebhook,
} from './mercadopago.js'
import {
  adjustItem, saveInventoryBatch, searchSales, attachPointOrder, closeStore, completeRefund,
  claimPointOrder, createItem, createSale, deleteItem, failRefund, getSale,
  getCashClosureWorkspace, getCashClosureRevision, getBootstrapData, getSaleByCheckoutKey, getSaleByPointOrder, getSalesMetrics, initializeStore, listItems, listMovements, listSales,
  markCardSaleFailed, prepareRefund, recordCreditNote, resolveRefundInventoryReview, saveCashClosure,
  updateItem, updateSaleFromPoint, updateSalePaymentDetails,
} from './store.js'
import { createDailyReport } from './report.js'
import { createCashClosurePdf } from './cash-closure-pdf.js'
import { closeChangeListener, listenForDatabaseChanges, subscribeToChanges } from './changes.js'

const app = express()
const port = Number(process.env.PORT || 3000)
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const htmlCacheControl = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300'

app.disable('x-powered-by')
app.set('trust proxy', process.env.RAILWAY_ENVIRONMENT_ID ? 1 : false)
app.use(compression({ filter: (req, res) => req.path !== '/api/events' && compression.filter(req, res) }))
app.use('/api', (_req, res, next) => {
  // Cookie-authenticated data and errors must never enter a shared edge cache.
  res.setHeader('Cache-Control', 'private, no-store')
  res.vary('Cookie')
  next()
})
app.use(express.json({ limit: '200kb' }))

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 })
}

function cleanItem(body, isUpdate = false) {
  const item = {
    name: String(body.name || '').trim(),
    category: String(body.category || '').trim(),
    unit: String(body.unit || '').trim(),
    lowStockThreshold: Number(body.lowStockThreshold ?? 0),
    sku: String(body.sku || '').trim(),
    expiryDate: body.expiryDate || null,
    price: Number(body.price ?? 0),
    sellable: body.sellable === true,
  }
  if (!isUpdate) item.quantity = Number(body.quantity ?? 0)
  if (!item.name || !item.category || !item.unit) throw badRequest('Name, category, and unit are required.')
  if (item.expiryDate !== null && (typeof item.expiryDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.expiryDate) || !parseCalendarDate(item.expiryDate))) {
    throw badRequest('Expiry date must be a valid calendar date (YYYY-MM-DD).')
  }
  if ((!isUpdate && (!Number.isFinite(item.quantity) || item.quantity < 0)) || !Number.isFinite(item.lowStockThreshold) || item.lowStockThreshold < 0) {
    throw badRequest('Quantities must be positive numbers.')
  }
  if (!Number.isInteger(item.price) || item.price < 0) throw badRequest('Price must be a whole Chilean peso amount.')
  if (item.sellable && item.price <= 0) throw badRequest('A product for sale must have a price greater than zero.')
  return item
}

function cleanCart(body) {
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 100) throw badRequest('Add at least one product to the sale.')
  const combined = new Map()
  for (const line of body.items) {
    const itemId = String(line.itemId || '')
    const quantity = Number(line.quantity)
    if (!itemId || !Number.isFinite(quantity) || quantity <= 0 || quantity > 10000) throw badRequest('The cart contains an invalid quantity.')
    combined.set(itemId, (combined.get(itemId) || 0) + quantity)
  }
  return [...combined.entries()].map(([itemId, quantity]) => ({ itemId, quantity }))
}

function checkoutKey(value) {
  if (value == null) return null // Older open tabs remain compatible during deployment.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw badRequest('Invalid checkout key.')
  return value.toLowerCase()
}

function cleanRefund(body) {
  const amount = Number(body.amount)
  if (!Number.isInteger(amount) || amount < 1) throw badRequest('Enter a refund amount of at least CLP 1.')
  if (body.items != null && !Array.isArray(body.items)) throw badRequest('The refund products are invalid.')
  const requestedItems = body.items || []
  if (requestedItems.length > 100) throw badRequest('The refund contains too many products.')
  const items = requestedItems.map((line) => {
    const lineId = String(line.lineId || '')
    const quantity = Number(line.quantity)
    if (!lineId || !Number.isFinite(quantity) || quantity <= 0 || quantity > 10000) throw badRequest('The refund contains an invalid quantity.')
    return { lineId, quantity }
  })
  const originalDocumentType = String(body.originalDocumentType || '')
  if (originalDocumentType && !['33', '34', '39', '41'].includes(originalDocumentType)) throw badRequest('The original tax document type is invalid.')
  return {
    amount,
    items,
    reason: String(body.reason || '').trim().slice(0, 300),
    restock: body.restock === true && items.length > 0,
    creditNoteRequired: body.creditNoteRequired === true,
    originalDocumentType,
    originalFolio: String(body.originalFolio || '').trim().slice(0, 30),
  }
}

function cleanCreditNote(body) {
  const input = {
    originalDocumentType: String(body.originalDocumentType || ''),
    originalFolio: String(body.originalFolio || '').trim(),
    folio: String(body.folio || '').trim(),
    siiTrackId: String(body.siiTrackId || '').trim().slice(0, 80),
  }
  if (!['33', '34', '39', '41'].includes(input.originalDocumentType)) throw badRequest('Select the original tax document type.')
  if (!/^\d{1,18}$/.test(input.originalFolio) || !/^\d{1,18}$/.test(input.folio)) throw badRequest('Enter valid numeric folios for both tax documents.')
  return input
}

function parseInstant(value, name) {
  const parsed = new Date(String(value || ''))
  if (Number.isNaN(parsed.getTime())) throw badRequest(`${name} must be a valid date.`)
  return parsed
}

function cleanMetricsPeriod(source) {
  const period = {
    from: parseInstant(source.from, 'from'),
    to: parseInstant(source.to, 'to'),
    previousFrom: parseInstant(source.previousFrom, 'previousFrom'),
    previousTo: parseInstant(source.previousTo, 'previousTo'),
    todayFrom: parseInstant(source.todayFrom, 'todayFrom'),
    todayTo: parseInstant(source.todayTo, 'todayTo'),
    businessDate: String(source.businessDate || ''),
  }
  if (period.from >= period.to || period.previousFrom >= period.previousTo || period.todayFrom >= period.todayTo) throw badRequest('The metrics date range is invalid.')
  if (period.to - period.from > 370 * 86400000) throw badRequest('The metrics date range is too large.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period.businessDate)) throw badRequest('businessDate must use YYYY-MM-DD.')
  return period
}

function requireProtectedPoint() {
  if (!pointConfiguration().configured) throw Object.assign(new Error('Point Smart 2 is not configured yet.'), { status: 503 })
  if (!pointAccessIsProtected() && !pointConfiguration().mockMode) {
    throw Object.assign(new Error('Set STAFF_PIN and SESSION_SECRET before enabling live Point payments.'), { status: 503 })
  }
}

function elapsedMilliseconds(startedAt) {
  return Math.round((performance.now() - startedAt) * 10) / 10
}

function sendPointTiming(res, requestId, timings) {
  res.setHeader('X-Request-ID', requestId)
  res.setHeader('Server-Timing', Object.entries(timings)
    .map(([name, duration]) => `${name};dur=${duration}`)
    .join(', '))
}

function logPointTiming(requestId, sale, outcome, timings) {
  console.info(JSON.stringify({
    event: 'point_order_timing',
    requestId,
    saleId: sale?.id || null,
    outcome,
    timings,
  }))
}

function requireMercadoPagoAdmin() {
  if (!process.env.MERCADOPAGO_ACCESS_TOKEN && process.env.MERCADOPAGO_MOCK !== 'true') {
    throw Object.assign(new Error('Mercado Pago account management is not configured yet.'), { status: 503 })
  }
}

function cleanPointStoreInput(body = {}) {
  const name = String(body.name || '').trim()
  const externalId = String(body.external_id || body.externalId || '').trim()
  if (!name || name.length > 120) throw badRequest('A store name between 1 and 120 characters is required.')
  if (externalId.length > 60) throw badRequest('The store external ID is too long.')
  const location = body.location && typeof body.location === 'object' ? body.location : {}
  const latitude = Number(location.latitude)
  const longitude = Number(location.longitude)
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw badRequest('A valid latitude and longitude are required to create a Mercado Pago store.')
  }
  return {
    name,
    external_id: externalId,
    location: Object.fromEntries(Object.entries(location).filter(([key, value]) => [
      'street_name', 'street_number', 'city_name', 'state_name', 'zip_code', 'reference', 'latitude', 'longitude',
    ].includes(key) && value !== null && value !== undefined && String(value).trim() !== '')),
  }
}

function cleanPointPosInput(body = {}) {
  const name = String(body.name || '').trim()
  const externalId = String(body.external_id || body.externalId || '').trim()
  if (!name || name.length > 120) throw badRequest('A POS name between 1 and 120 characters is required.')
  if (externalId.length > 60) throw badRequest('The POS external ID is too long.')
  return {
    name,
    external_id: externalId,
    store_id: body.store_id ? String(body.store_id).trim() : undefined,
    external_store_id: body.external_store_id ? String(body.external_store_id).trim() : undefined,
    category: body.category ? String(body.category).trim().slice(0, 80) : undefined,
    url: body.url ? String(body.url).trim().slice(0, 500) : undefined,
    fixed_amount: body.fixed_amount === undefined ? undefined : Boolean(body.fixed_amount),
  }
}

async function enrichPointPayment(sale, order) {
  const paymentReference = order?.transactions?.payments?.[0]?.reference_id
  if (!sale || !paymentReference) return sale
  try {
    const payment = await getPointPayment(paymentReference)
    return await updateSalePaymentDetails(sale.id, payment) || sale
  } catch (error) {
    console.error('Mercado Pago payment enrichment failed:', error)
    return sale
  }
}

async function completePointSaleAfterApproval(sale, order) {
  return enrichPointPayment(sale, order)
}

async function reconcilePointSale(sale, knownOrder = null) {
  if (!sale?.mpOrderId && !knownOrder?.id) return sale
  const order = knownOrder || await getPointOrder(sale.mpOrderId, sale)
  const updated = await updateSaleFromPoint(order)
  return completePointSaleAfterApproval(updated || sale, order)
}

app.get('/api/health', (_req, res) => res.json({ ok: true }))

app.post('/api/mercadopago/webhook', async (req, res, next) => {
  try {
    const dataId = String(req.query['data.id'] || req.body?.data?.id || '').trim()
    const signatureValid = validatePointWebhook({
      signature: req.headers['x-signature'],
      requestId: req.headers['x-request-id'],
      dataId,
    })
    let knownSale = null

    if (!signatureValid) {
      // Some live Point notifications have produced signatures that differ from
      // the dashboard simulator. Never trust that payload: only use a known,
      // high-entropy order id as a hint and fetch the authoritative order below.
      if (!/^ORD[A-Z0-9]{20,}$/i.test(dataId)) return res.status(401).json({ error: 'Invalid webhook signature.' })
      knownSale = await getSaleByPointOrder(dataId)
      if (!knownSale) return res.status(401).json({ error: 'Invalid webhook signature.' })
      console.warn(JSON.stringify({
        event: 'point_webhook_signature_fallback',
        requestId: req.headers['x-request-id'] || null,
        saleId: knownSale.id,
        orderId: dataId,
      }))
    }

    res.status(200).end()
    setImmediate(async () => {
      const startedAt = performance.now()
      try {
        const sale = knownSale || await getSaleByPointOrder(dataId)
        if (!sale && pointConfiguration().mockMode) return
        const order = await getPointOrder(dataId, sale)
        const updatedSale = await reconcilePointSale(sale, order)
        console.info(JSON.stringify({
          event: 'point_webhook_status',
          requestId: req.headers['x-request-id'] || null,
          signatureValid,
          saleId: updatedSale?.id || sale?.id || null,
          from: sale?.mpStatus || null,
          to: updatedSale?.mpStatus || order.status || null,
          status: updatedSale?.status || null,
          ageMs: updatedSale ? Date.now() - new Date(updatedSale.createdAt).getTime() : null,
          totalMs: elapsedMilliseconds(startedAt),
        }))
      } catch (error) {
        console.error('Mercado Pago webhook processing failed:', error)
      }
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/auth/status', (req, res) => res.json(authStatus(req)))
app.post('/api/auth/login', login)
app.post('/api/auth/logout', logout)
app.get('/api/bootstrap', async (req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store')
  const auth = authStatus(req)
  if (!auth.authenticated) return res.json({ auth })
  try {
    const startedAt = performance.now()
    const data = await getBootstrapData()
    res.setHeader('Server-Timing', `data;dur=${elapsedMilliseconds(startedAt)}`)
    res.json({ auth, ...data, posConfig: pointConfiguration() })
  } catch (error) { next(error) }
})
app.use('/api', requireAuth)

const eventStreams = new Set()
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'private, no-store', 'X-Accel-Buffering': 'no' })
  res.flushHeaders()
  eventStreams.add(res)
  let debounce
  const unsubscribe = subscribeToChanges(() => {
    clearTimeout(debounce)
    debounce = setTimeout(() => { if (!res.destroyed) res.write('event: change\ndata: {}\n\n') }, 50)
  })
  const heartbeat = setInterval(() => {
    if (!authStatus(req).authenticated) {
      res.write('event: unauthorized\ndata: {}\n\n')
      res.end()
    } else res.write(': heartbeat\n\n')
  }, 20000)
  res.write('event: ready\ndata: {}\n\n')
  res.on('close', () => { clearTimeout(debounce); clearInterval(heartbeat); unsubscribe(); eventStreams.delete(res) })
})

app.get('/api/checkouts/:key', async (req, res, next) => {
  try {
    const sale = await getSaleByCheckoutKey(checkoutKey(req.params.key))
    if (!sale) return res.status(404).json({ error: 'Checkout not found.' })
    res.json(sale)
  } catch (error) { next(error) }
})

app.get('/api/items', async (_req, res, next) => {
  try { res.json(await listItems()) } catch (error) { next(error) }
})
app.post('/api/inventory/batch', async (req, res, next) => {
  try { res.json(await saveInventoryBatch(req.body, req.headers['idempotency-key'])) } catch (error) { next(error) }
})
app.post('/api/items', async (req, res, next) => {
  try { res.status(201).json(await createItem(cleanItem(req.body))) } catch (error) { next(error) }
})
app.patch('/api/items/:id', async (req, res, next) => {
  try {
    const item = await updateItem(req.params.id, cleanItem(req.body, true))
    if (!item) return res.status(404).json({ error: 'Product not found.' })
    res.json(item)
  } catch (error) { next(error) }
})
app.delete('/api/items/:id', async (req, res, next) => {
  try {
    const item = await deleteItem(req.params.id)
    if (!item) return res.status(404).json({ error: 'Product not found.' })
    res.json(item)
  } catch (error) { next(error) }
})
app.post('/api/items/:id/adjust', async (req, res, next) => {
  try {
    const type = req.body.type
    const quantity = Number(req.body.quantity)
    if (!['stock_in', 'stock_out', 'adjustment'].includes(type)) throw badRequest('Invalid stock action.')
    if (!Number.isFinite(quantity) || quantity < 0 || (type !== 'adjustment' && quantity === 0)) throw badRequest('Enter a valid quantity.')
    const item = await adjustItem(req.params.id, { type, quantity, note: String(req.body.note || '').trim() })
    if (!item) return res.status(404).json({ error: 'Product not found.' })
    res.json(item)
  } catch (error) { next(error) }
})
app.get('/api/movements', async (req, res, next) => {
  try { res.json(await listMovements(Math.min(Number(req.query.limit) || 50, 200))) } catch (error) { next(error) }
})

app.get('/api/metrics', async (req, res, next) => {
  try { res.json(await getSalesMetrics(cleanMetricsPeriod(req.query))) } catch (error) { next(error) }
})
app.get('/api/cash-closures', async (req, res, next) => {
  try { res.json(await getCashClosureWorkspace(req.query.date)) } catch (error) { next(error) }
})
app.post('/api/cash-closures', async (req, res, next) => {
  try { res.json(await saveCashClosure(req.body)) } catch (error) { next(error) }
})
app.get('/api/cash-closures/:date/pdf', async (req, res, next) => {
  try {
    const closure = await getCashClosureRevision(req.params.date, req.query.revision)
    const bytes = await createCashClosurePdf(closure)
    res.set({ 'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="bakery-pos-cierre-${closure.businessDate}-v${closure.revision}.pdf"`,
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }).send(bytes)
  } catch (error) { next(error) }
})
app.get('/api/reports/daily', async (req, res, next) => {
  try {
    const period = cleanMetricsPeriod(req.query)
    const language = req.query.language === 'en' ? 'en' : 'es'
    const [metrics, items] = await Promise.all([getSalesMetrics(period), listItems()])
    const report = createDailyReport({ metrics, items, businessDate: period.businessDate, language })
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `attachment; filename="bakery-report-${period.businessDate}.html"`,
      'Cache-Control': 'no-store',
    }).send(report)
  } catch (error) { next(error) }
})

app.get('/api/sales', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'private, no-cache')
    res.json(await listSales(Math.min(Number(req.query.limit) || 50, 200)))
  } catch (error) { next(error) }
})
app.post('/api/sales/cash', async (req, res, next) => {
  try {
    const sale = await createSale(cleanCart(req.body), 'cash', checkoutKey(req.headers['idempotency-key']), req.body.cashReceived ?? null)
    res.status(sale.checkoutReplayed ? 200 : 201).json(sale)
  } catch (error) { next(error) }
})
app.get('/api/sales/history', async (req, res, next) => {
  try { res.json(await searchSales(req.query)) } catch (error) { next(error) }
})
app.post('/api/sales/card', async (req, res, next) => {
  let sale
  const requestId = crypto.randomUUID()
  const requestStartedAt = performance.now()
  const timings = {}
  try {
    requireProtectedPoint()
    const reserveStartedAt = performance.now()
    sale = await createSale(cleanCart(req.body), 'card', checkoutKey(req.headers['idempotency-key']))
    // A replay only recovers the original sale, including uncertain reservations.
    // It must not send a second terminal order or fail another request's sale.
    if (sale.checkoutReplayed) return res.json(sale)
    if (!await claimPointOrder(sale.id)) return res.status(202).json(await getSale(sale.id))
    timings.reserve = elapsedMilliseconds(reserveStartedAt)
    const mercadoPagoStartedAt = performance.now()
    const order = await createPointOrder(sale)
    timings.mercadopago = elapsedMilliseconds(mercadoPagoStartedAt)
    const persistStartedAt = performance.now()
    const attachedSale = await attachPointOrder(sale.id, order, sale)
    timings.persist = elapsedMilliseconds(persistStartedAt)
    timings.total = elapsedMilliseconds(requestStartedAt)
    sendPointTiming(res, requestId, timings)
    logPointTiming(requestId, attachedSale, 'created', timings)
    res.status(201).json({ ...attachedSale, pointTiming: timings, requestId })
  } catch (error) {
    if (sale && !error.uncertain) await markCardSaleFailed(sale.id, error.mercadoPagoCode || 'order_creation_failed').catch(console.error)
    if (sale) error.saleId = sale.id
    timings.total = elapsedMilliseconds(requestStartedAt)
    sendPointTiming(res, requestId, timings)
    logPointTiming(requestId, sale, error.uncertain ? 'uncertain' : 'failed', timings)
    next(error)
  }
})
app.post('/api/sales/:id/retry-card', async (req, res, next) => {
  let sale
  const requestId = crypto.randomUUID()
  const requestStartedAt = performance.now()
  const timings = {}
  try {
    requireProtectedPoint()
    const lookupStartedAt = performance.now()
    sale = await getSale(req.params.id)
    timings.lookup = elapsedMilliseconds(lookupStartedAt)
    if (!sale) return res.status(404).json({ error: 'Sale not found.' })
    if (sale.paymentMethod !== 'card' || sale.status !== 'pending') throw Object.assign(new Error('This card sale cannot be retried.'), { status: 409 })
    if (sale.mpOrderId) return res.json(sale)
    if (!await claimPointOrder(sale.id)) return res.status(202).json(await getSale(sale.id))
    const mercadoPagoStartedAt = performance.now()
    const order = await createPointOrder(sale)
    timings.mercadopago = elapsedMilliseconds(mercadoPagoStartedAt)
    const persistStartedAt = performance.now()
    const attachedSale = await attachPointOrder(sale.id, order, sale)
    timings.persist = elapsedMilliseconds(persistStartedAt)
    timings.total = elapsedMilliseconds(requestStartedAt)
    sendPointTiming(res, requestId, timings)
    logPointTiming(requestId, attachedSale, 'created_after_retry', timings)
    res.json({ ...attachedSale, pointTiming: timings, requestId })
  } catch (error) {
    if (sale && !error.uncertain) await markCardSaleFailed(sale.id, error.mercadoPagoCode || 'order_creation_failed').catch(console.error)
    if (sale) error.saleId = sale.id
    timings.total = elapsedMilliseconds(requestStartedAt)
    sendPointTiming(res, requestId, timings)
    logPointTiming(requestId, sale, error.uncertain ? 'uncertain_after_retry' : 'retry_failed', timings)
    next(error)
  }
})
app.get('/api/sales/:id', async (req, res, next) => {
  try {
    let sale = await getSale(req.params.id)
    if (!sale) return res.status(404).json({ error: 'Sale not found.' })
    if (req.query.refresh === 'true' && sale.paymentMethod === 'card' && sale.status === 'pending' && sale.mpOrderId && pointConfiguration().configured) {
      const previousPointStatus = sale.mpStatus
      const refreshStartedAt = performance.now()
      const mercadoPagoStartedAt = performance.now()
      const order = await getPointOrder(sale.mpOrderId, sale)
      const mercadoPagoDuration = elapsedMilliseconds(mercadoPagoStartedAt)
      const paymentId = order?.transactions?.payments?.[0]?.id || null
      const pointStateChanged = order.status !== sale.mpStatus
        || order.status_detail !== sale.mpStatusDetail
        || (paymentId && paymentId !== sale.mpPaymentId)
      let persistDuration = 0
      if (pointStateChanged) {
        const persistStartedAt = performance.now()
        sale = await updateSaleFromPoint(order)
        persistDuration = elapsedMilliseconds(persistStartedAt)
        if (sale.status !== 'pending') setImmediate(() => completePointSaleAfterApproval(sale, order).catch(console.error))
      }
      const timings = {
        mercadopago: mercadoPagoDuration,
        persist: persistDuration,
        total: elapsedMilliseconds(refreshStartedAt),
      }
      sendPointTiming(res, crypto.randomUUID(), timings)
      if (sale.mpStatus !== previousPointStatus || sale.status !== 'pending') {
        console.info(JSON.stringify({
          event: 'point_order_status',
          saleId: sale.id,
          from: previousPointStatus,
          to: sale.mpStatus,
          status: sale.status,
          ageMs: Date.now() - new Date(sale.createdAt).getTime(),
          timings,
        }))
      }
    }
    res.json(sale)
  } catch (error) { next(error) }
})
app.post('/api/sales/:id/reconcile-point', async (req, res, next) => {
  try {
    requireProtectedPoint()
    const sale = await getSale(req.params.id)
    if (!sale) return res.status(404).json({ error: 'Sale not found.' })
    if (sale.paymentMethod !== 'card' || !sale.mpOrderId) {
      throw Object.assign(new Error('This sale has no Point order to synchronize.'), { status: 409 })
    }
    res.json(await reconcilePointSale(sale))
  } catch (error) { next(error) }
})
app.post('/api/sales/:id/cancel', async (req, res, next) => {
  try {
    const sale = await getSale(req.params.id)
    if (!sale) return res.status(404).json({ error: 'Sale not found.' })
    if (sale.paymentMethod !== 'card' || sale.status !== 'pending') throw Object.assign(new Error('Only a pending card sale can be cancelled.'), { status: 409 })
    if (!sale.mpOrderId) throw Object.assign(new Error('Retry the Mercado Pago connection before cancelling this sale.'), { status: 409 })
    const order = await cancelPointOrder(sale.mpOrderId, sale)
    res.json(await updateSaleFromPoint(order))
  } catch (error) { next(error) }
})
app.post('/api/sales/:id/refunds', async (req, res, next) => {
  let prepared
  try {
    const existing = await getSale(req.params.id)
    if (!existing) return res.status(404).json({ error: 'Sale not found.' })
    if (existing.paymentMethod === 'card') requireProtectedPoint()
    prepared = await prepareRefund(existing.id, cleanRefund(req.body))
    if (!prepared) return res.status(404).json({ error: 'Sale not found.' })

    if (existing.paymentMethod === 'cash') {
      return res.status(201).json(await completeRefund(prepared.refund.id))
    }
    if (!existing.mpOrderId) throw Object.assign(new Error('This card sale has no Mercado Pago order to refund.'), { status: 409 })
    const order = await refundPointOrder(existing.mpOrderId, existing, { ...prepared.refund, full: prepared.full })
    res.status(201).json(await completeRefund(prepared.refund.id, order))
  } catch (error) {
    if (prepared?.refund && !error.uncertain) await failRefund(prepared.refund.id, error.mercadoPagoCode || error.message).catch(console.error)
    if (prepared?.refund) error.refundId = prepared.refund.id
    next(error)
  }
})
app.post('/api/sales/:saleId/refunds/:refundId/retry', async (req, res, next) => {
  try {
    requireProtectedPoint()
    const sale = await getSale(req.params.saleId)
    if (!sale) return res.status(404).json({ error: 'Sale not found.' })
    const refund = sale.refunds.find((entry) => entry.id === req.params.refundId)
    if (!refund) return res.status(404).json({ error: 'Refund not found.' })
    if (sale.paymentMethod !== 'card' || refund.status !== 'pending' || !sale.mpOrderId) {
      throw Object.assign(new Error('This refund cannot be retried.'), { status: 409 })
    }
    const order = await refundPointOrder(sale.mpOrderId, sale, {
      ...refund,
      full: sale.refundedTotal + refund.amount >= sale.total,
    })
    res.json(await completeRefund(refund.id, order))
  } catch (error) { next(error) }
})
app.patch('/api/sales/:saleId/refunds/:refundId/credit-note', async (req, res, next) => {
  try {
    const sale = await recordCreditNote(req.params.saleId, req.params.refundId, cleanCreditNote(req.body))
    if (!sale) return res.status(404).json({ error: 'Processed refund not found.' })
    res.json(sale)
  } catch (error) { next(error) }
})
app.patch('/api/sales/:saleId/refunds/:refundId/inventory-review', async (req, res, next) => {
  try {
    if (typeof req.body?.restock !== 'boolean') throw badRequest('Choose whether the returned products go back into inventory.')
    const sale = await resolveRefundInventoryReview(req.params.saleId, req.params.refundId, req.body.restock)
    if (!sale) return res.status(404).json({ error: 'Refund not found.' })
    res.json(sale)
  } catch (error) { next(error) }
})
app.post('/api/sales/:saleId/refunds/:refundId/print-copy', async (req, res, next) => {
  try {
    requireProtectedPoint()
    const sale = await getSale(req.params.saleId)
    if (!sale) return res.status(404).json({ error: 'Sale not found.' })
    const refund = sale.refunds.find((entry) => entry.id === req.params.refundId)
    if (!refund) return res.status(404).json({ error: 'Refund not found.' })
    if (sale.paymentMethod !== 'card' || refund.status !== 'processed') {
      throw Object.assign(new Error('Only a processed Point refund can be printed.'), { status: 409 })
    }
    res.status(202).json(await printPointRefundCopy(sale, refund))
  } catch (error) { next(error) }
})

app.get('/api/pos/config', (_req, res) => res.json(pointConfiguration()))
app.get('/api/pos/terminal', async (_req, res, next) => {
  try { requireProtectedPoint(); res.json(await getConfiguredTerminal()) } catch (error) { next(error) }
})
app.get('/api/pos/management', async (_req, res, next) => {
  try {
    requireMercadoPagoAdmin()
    const [account, stores, registers, terminals] = await Promise.all([
      getMercadoPagoAccount(), listPointStores(), listPointPos(), listPointTerminals(),
    ])
    res.json(buildPointManagement({
      account,
      stores: stores.stores,
      registers: registers.registers,
      terminals: terminals.terminals,
      paging: { stores: stores.paging, registers: registers.paging, terminals: terminals.paging },
    }))
  } catch (error) { next(error) }
})
app.get('/api/pos/stores', async (req, res, next) => {
  try { requireMercadoPagoAdmin(); res.json(await listPointStores({ externalId: req.query.external_id, limit: req.query.limit, offset: req.query.offset })) } catch (error) { next(error) }
})
app.post('/api/pos/stores', async (req, res, next) => {
  try { requireMercadoPagoAdmin(); res.status(201).json(await createPointStore(cleanPointStoreInput(req.body))) } catch (error) { next(error) }
})
app.get('/api/pos/stores/:storeId', async (req, res, next) => {
  try { requireMercadoPagoAdmin(); res.json(await getPointStore(req.params.storeId)) } catch (error) { next(error) }
})
app.put('/api/pos/stores/:storeId', async (req, res, next) => {
  try { requireMercadoPagoAdmin(); res.json(await updatePointStore(req.params.storeId, cleanPointStoreInput(req.body))) } catch (error) { next(error) }
})
app.delete('/api/pos/stores/:storeId', async (req, res, next) => {
  try {
    requireMercadoPagoAdmin()
    const [registers, terminals] = await Promise.all([
      listPointPos({ storeId: req.params.storeId }),
      listPointTerminals({ storeId: req.params.storeId }),
    ])
    const linkedRegisters = registers.registers.filter((register) => String(register.store_id) === String(req.params.storeId))
    const linkedTerminals = terminals.terminals.filter((terminal) => String(terminal.store_id) === String(req.params.storeId))
    if (linkedRegisters.length || linkedTerminals.length) {
      throw Object.assign(new Error('Move or delete the store cash registers before deleting this Mercado Pago store.'), { status: 409 })
    }
    res.json(await deletePointStore(req.params.storeId))
  } catch (error) { next(error) }
})
app.get('/api/pos/registers', async (req, res, next) => {
  try {
    requireMercadoPagoAdmin()
    res.json(await listPointPos({ externalId: req.query.external_id, externalStoreId: req.query.external_store_id, storeId: req.query.store_id, limit: req.query.limit, offset: req.query.offset }))
  } catch (error) { next(error) }
})
app.post('/api/pos/registers', async (req, res, next) => {
  try { requireMercadoPagoAdmin(); res.status(201).json(await createPointPos(cleanPointPosInput(req.body))) } catch (error) { next(error) }
})
app.get('/api/pos/registers/:registerId', async (req, res, next) => {
  try { requireMercadoPagoAdmin(); res.json(await getPointPos(req.params.registerId)) } catch (error) { next(error) }
})
app.put('/api/pos/registers/:registerId', async (req, res, next) => {
  try { requireMercadoPagoAdmin(); res.json(await updatePointPos(req.params.registerId, cleanPointPosInput(req.body))) } catch (error) { next(error) }
})
app.delete('/api/pos/registers/:registerId', async (req, res, next) => {
  try {
    requireMercadoPagoAdmin()
    const terminals = await listPointTerminals({ posId: req.params.registerId })
    if (terminals.terminals.some((terminal) => String(terminal.pos_id) === String(req.params.registerId))) {
      throw Object.assign(new Error('Move the Point terminal to another cash register before deleting this one.'), { status: 409 })
    }
    res.json(await deletePointPos(req.params.registerId))
  } catch (error) { next(error) }
})
app.get('/api/pos/terminals', async (req, res, next) => {
  try { requireMercadoPagoAdmin(); res.json(await listPointTerminals({ storeId: req.query.store_id, posId: req.query.pos_id, limit: req.query.limit, offset: req.query.offset })) } catch (error) { next(error) }
})
app.patch('/api/pos/terminals/:terminalId/mode', async (req, res, next) => {
  try {
    requireMercadoPagoAdmin()
    const mode = String(req.body?.operating_mode || '').toUpperCase()
    res.json(await setupPointTerminal(req.params.terminalId, mode))
  } catch (error) { next(error) }
})

app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }))

const distPath = path.join(root, 'dist')
app.use(express.static(distPath, {
  index: false,
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    else if (filePath.endsWith('.html')) res.setHeader('Cache-Control', htmlCacheControl)
  },
}))
app.use('/assets', (_req, res) => {
  // Never return/cache the SPA shell as a missing JavaScript, CSS, or image file.
  res.setHeader('Cache-Control', 'private, no-store')
  res.status(404).json({ error: 'Asset not found.' })
})
app.get('/{*splat}', (_req, res) => res.sendFile(path.join(distPath, 'index.html'), {
  // This shell contains no user data; bootstrap always checks the live session.
  headers: { 'Cache-Control': htmlCacheControl },
}))

app.use((error, _req, res, _next) => {
  console.error(error)
  res.setHeader('Cache-Control', 'private, no-store')
  const status = error.status || 500
  res.status(status).json({
    error: status < 500 || error.status ? error.message : 'Something went wrong. Please try again.',
    ...(error.code ? { code: error.code } : {}),
    ...(error.pointStatus ? { pointStatus: error.pointStatus } : {}),
    ...(error.saleId ? { saleId: error.saleId } : {}),
    ...(error.refundId ? { refundId: error.refundId } : {}),
    ...(error.uncertain ? { uncertain: true } : {}),
  })
})

await initializeStore()
await listenForDatabaseChanges(process.env.DATABASE_URL)
const pointSecurity = pointConfiguration()
console.info(JSON.stringify({
  event: 'point_integration_configuration',
  credentialsCentralized: pointSecurity.credentialsCentralized,
  credentialStorage: pointSecurity.credentialStorage,
  credentialsExposedToClient: pointSecurity.credentialsExposedToClient,
  accessTokenTransport: pointSecurity.accessTokenTransport,
  webhookConfigured: pointSecurity.webhookConfigured,
  webhookMode: pointSecurity.webhookMode,
  webhookTopic: pointSecurity.webhookTopic,
  webhookSignatureValidation: pointSecurity.webhookSignatureValidation,
  webhookAuthoritativeOrderLookup: pointSecurity.webhookAuthoritativeOrderLookup,
}))
const server = app.listen(port, '0.0.0.0', () => console.log(`Bakery POS listening on port ${server.address().port}`))

async function shutdown() {
  for (const stream of eventStreams) stream.end()
  await closeChangeListener()
  server.close(async () => {
    await closeStore()
    process.exit(0)
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
