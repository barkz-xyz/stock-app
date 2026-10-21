import crypto from 'node:crypto'
import express from 'express'
import { dateOnly, parseCalendarDate } from '../src/dates.js'
import { integrationError, tokenDigest } from './integration-store.js'

export const inventoryReadLimits = { perMinute: 60, burst: 15, burstSeconds: 10, perIpMinute: 300 }
export const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

export function inventoryApiConfiguration(env = process.env) {
  const production = env.NODE_ENV === 'production' || Boolean(env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_PROJECT_ID)
  const environment = env.INVENTORY_API_ENVIRONMENT || (production ? 'production' : 'test')
  if (!['production', 'test'].includes(environment)) throw new Error('INVENTORY_API_ENVIRONMENT must be test or production.')
  const reservationTtlSeconds = Number(env.INVENTORY_RESERVATION_TTL_SECONDS || 900)
  if (!Number.isInteger(reservationTtlSeconds) || reservationTtlSeconds < 60 || reservationTtlSeconds > 1800) throw new Error('INVENTORY_RESERVATION_TTL_SECONDS must be between 60 and 1800.')
  return { enabled: env.INVENTORY_API_ENABLED === 'true', environment, production,
    reservationsEnabled: env.INVENTORY_RESERVATIONS_ENABLED === 'true', reservationTtlSeconds }
}

export function inventoryItem(row) {
  const quantity = row.quantity
  const number = Number(quantity)
  if (quantity == null || typeof quantity === 'string' && !/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$/.test(quantity) || !Number.isFinite(number) || number < 0 || number > 9999999999.99 ||
      Math.abs(number * 100 - Math.round(number * 100)) > 0.0002) throw new Error('Invalid inventory quantity')
  const stockQuantity = number.toFixed(2)
  const price = Number(row.price)
  const rawExpiryDate = row.expiry_date ?? row.expiryDate
  const expiryDate = dateOnly(rawExpiryDate)
  if (!isUuid(row.id) || !row.name || !row.category || !row.unit || row.price == null || !Number.isSafeInteger(price) || price < 0 || price > 999999999999 ||
      rawExpiryDate != null && (!expiryDate || !parseCalendarDate(expiryDate))) throw new Error('Invalid inventory data')
  const updatedAt = new Date(row.updated_at ?? row.updatedAt).toISOString()
  return { id: row.id.toLowerCase(), sku: String(row.sku || '').trim() || null, name: row.name, category: row.category,
    unit: row.unit, stockQuantity, price: { amount: price, currency: 'CLP' }, sellable: row.sellable === true, expiryDate, updatedAt }
}

export function inventoryRepresentation(rows, single = false) {
  const items = rows.map(inventoryItem).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const data = single ? items[0] : { apiVersion: '1', inventoryPoolId: 'global', complete: true, count: items.length, items }
  const body = JSON.stringify(data)
  return { body, etag: `W/"inventory-${crypto.createHash('sha256').update(body).digest('base64url')}"` }
}

export function matchesInventoryEtag(header, etag) {
  return String(header || '').split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''))
}

export function replyError(error, req, res) {
  const status = error.status >= 400 && error.status < 500 ? error.status : 503
  if (status === 503) res.set('Retry-After', '60')
  if (status === 401) res.set('WWW-Authenticate', 'Bearer realm="inventory", error="invalid_token"')
  if (status === 403) res.set('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${req.integrationScope || 'inventory:read'}"`)
  return res.status(status).json({ error: { code: status === 503 ? error.code === 'API_DISABLED' ? 'API_DISABLED' : 'SERVICE_UNAVAILABLE' : error.code || 'INVALID_REQUEST',
    message: status === 503 ? 'Inventory API is unavailable.' : error.message, requestId: req.inventoryRequestId } })
}

export function createIntegrationAccessRouter({ getStore, config, scope = 'inventory:read' }) {
  const router = express.Router()
  router.use((req, res, next) => {
    const started = performance.now()
    req.inventoryRequestId = crypto.randomUUID()
    req.integrationScope = scope
    res.set({ 'Cache-Control': 'private, no-store', 'X-Request-ID': req.inventoryRequestId })
    res.vary('Authorization')
    res.on('finish', () => console.info(JSON.stringify({ event: 'inventory_api_request', requestId: req.inventoryRequestId,
      clientId: req.integration?.id || null, method: req.method, route: req.route?.path || 'unknown',
      status: res.statusCode, durationMs: Math.round(performance.now() - started) })))
    next()
  })
  router.use(async (req, res, next) => {
    try {
      if (!config.enabled) throw integrationError('Disabled', 503, 'API_DISABLED')
      const store = getStore()
      const retry = await store.consumeLimits([{ key: `ip:${tokenDigest(req.ip || req.socket.remoteAddress || 'unknown')}`, seconds: 60, limit: inventoryReadLimits.perIpMinute }])
      if (retry) { res.set('Retry-After', String(retry)); throw integrationError('Too many requests.', 429, 'RATE_LIMITED') }
      const authorization = req.headers.authorization || ''
      const match = /^Bearer (bpos_(test|live)_[A-Za-z0-9_-]{43})$/i.exec(authorization)
      if (!match || match[2].toLowerCase() !== (config.environment === 'production' ? 'live' : 'test')) throw integrationError('Invalid integration credential.', 401, 'UNAUTHORIZED')
      req.integration = await store.authenticate(tokenDigest(match[1]), config.environment)
      if (!req.integration) throw integrationError('Invalid integration credential.', 401, 'UNAUTHORIZED')
      if (!req.integration.scopes.includes(scope)) throw integrationError(`Missing ${scope} permission.`, 403, 'FORBIDDEN')
      const limited = await store.consumeLimits([
        { key: `client:${req.integration.id}:minute`, seconds: 60, limit: inventoryReadLimits.perMinute },
        { key: `client:${req.integration.id}:burst`, seconds: inventoryReadLimits.burstSeconds, limit: inventoryReadLimits.burst },
      ])
      if (limited) { res.set('Retry-After', String(limited)); throw integrationError('Too many requests.', 429, 'RATE_LIMITED') }
      if (Object.keys(req.query).length) throw integrationError('Query parameters are not supported.', 400, 'INVALID_REQUEST')
      next()
    } catch (error) { replyError(error, req, res) }
  })
  return router
}

export function createInventoryRouter({ getStore, config }) {
  const router = express.Router()
  router.use(createIntegrationAccessRouter({ getStore, config }))
  router.use((req, res, next) => {
    if (req.method !== 'GET') { res.set('Allow', 'GET'); return replyError(integrationError('Only GET is supported.', 405, 'METHOD_NOT_ALLOWED'), req, res) }
    next()
  })
  const respond = single => async (req, res) => {
    try {
      const itemId = single ? req.params.itemId : null
      if (single && !isUuid(itemId)) throw integrationError('Invalid product UUID.', 400, 'INVALID_REQUEST')
      const rows = await getStore().readInventory(itemId)
      if (single && !rows.length) throw integrationError('Product not found.', 404, 'NOT_FOUND')
      const { body, etag } = inventoryRepresentation(rows, single)
      res.set('ETag', etag)
      if (matchesInventoryEtag(req.headers['if-none-match'], etag)) return res.status(304).end()
      res.type('json').send(body)
    } catch (error) { replyError(error, req, res) }
  }
  router.get('/inventory', respond(false))
  router.get('/inventory/:itemId', respond(true))
  router.use((req, res) => replyError(integrationError('Integration route not found.', 404, 'NOT_FOUND'), req, res))
  router.use((error, req, res, _next) => replyError(error, req, res))
  return router
}

function keyInput(body = {}, needsName = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['name', 'expiresInDays', ...(needsName ? ['reservationsEnabled'] : [])].includes(k))) throw integrationError('Parámetros inválidos.')
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const expiresInDays = body.expiresInDays ?? 90
  if (needsName && (!name || name.length > 80)) throw integrationError('Ingresa un nombre de hasta 80 caracteres.')
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) throw integrationError('La vigencia debe ser de 1 a 365 días.')
  if (needsName && body.reservationsEnabled != null && typeof body.reservationsEnabled !== 'boolean') throw integrationError('Permiso inválido.')
  return { name, expiresInDays, ...(needsName ? { reservationsEnabled: body.reservationsEnabled === true } : {}) }
}

export function createIntegrationAdminRouter({ getStore, getReservations, config }) {
  const router = express.Router()
  router.get('/', async (_req, res) => res.json({ enabled: config.enabled, environment: config.environment,
    reservationsEnabled: config.reservationsEnabled === true, reservationsSupported: getReservations?.().persistent === true,
    reservationPolicy: getReservations?.().policy, limits: inventoryReadLimits, endpoint: '/api/integrations/v1/inventory', clients: await getStore().listClients(config.environment) }))
  router.post('/', async (req, res) => res.status(201).json(await getStore().createClient({ ...keyInput(req.body, true), environment: config.environment, createdBy: req.user.id })))
  router.patch('/:clientId', async (req, res) => {
    if (!isUuid(req.params.clientId) || !req.body || Object.keys(req.body).length !== 1 || typeof req.body.reservationsEnabled !== 'boolean') throw integrationError('Permiso inválido.')
    res.json(await getStore().setReservationAccess(req.params.clientId, config.environment, req.body.reservationsEnabled))
  })
  router.post('/:clientId/keys', async (req, res) => {
    if (!isUuid(req.params.clientId)) throw integrationError('Identificador inválido.')
    res.status(201).json(await getStore().rotateKey(req.params.clientId, config.environment, keyInput(req.body).expiresInDays))
  })
  router.post('/:clientId/keys/:keyId/revoke', async (req, res) => {
    if (!isUuid(req.params.clientId) || !isUuid(req.params.keyId)) throw integrationError('Identificador inválido.')
    res.json(await getStore().revokeKey(req.params.clientId, req.params.keyId, config.environment))
  })
  router.delete('/:clientId/keys/:keyId', async (req, res) => {
    if (!isUuid(req.params.clientId) || !isUuid(req.params.keyId)) throw integrationError('Identificador inválido.')
    res.json(await getStore().deleteKey(req.params.clientId, req.params.keyId, config.environment))
  })
  router.delete('/:clientId', async (req, res) => {
    if (!isUuid(req.params.clientId)) throw integrationError('Identificador inválido.')
    res.json(await getStore().deleteClient(req.params.clientId, config.environment))
  })
  return router
}
